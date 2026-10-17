package dev.mcpanel.linkbridge;

import fr.xephi.authme.api.v3.AuthMeApi;
import fr.xephi.authme.events.LoginEvent;
import fr.xephi.authme.events.RegisterEvent;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * Redeems a one-time code, issued by the web panel, against the panel's internal
 * {@code /internal/link/claim} endpoint, and points unlinked players at the panel
 * once they have authenticated.
 *
 * <p>The plugin is deliberately dumb about links: it holds no state about who is
 * linked to what, never sees a password, and never touches the database. The
 * panel is the only source of truth for "which Minecraft account belongs to
 * which panel account". All the plugin does there is prove that the player has
 * already authenticated in-game before it vouches for them.
 *
 * <p>The plugin also measures in-game activity — time a player is online and
 * blocks placed or broken — and reports the growth since the panel last
 * accepted a report to {@code /internal/stats/report}, so the panel can show
 * per-account statistics. Activity only counts after AuthMe has authenticated
 * the player: before that they are standing at the login gate, not playing.
 */
public final class LinkBridgePlugin extends JavaPlugin implements CommandExecutor, Listener {

    private static final String PREFIX = "[Link] ";

    /** Ten server ticks: how often play time is sampled into the counters. */
    private static final long PLAY_TICK_TICKS = 200L;

    /** Player UUID to the epoch millisecond of their last /website attempt. */
    private final Map<UUID, Long> lastAttempt = new ConcurrentHashMap<>();

    /** Cumulative activity measured since the plugin started, per player UUID. */
    private final Map<UUID, Counters> totals = new ConcurrentHashMap<>();
    /** Deltas already accepted by the panel, per player UUID. */
    private final Map<UUID, Counters> reported = new ConcurrentHashMap<>();
    /** Names seen from a Player object; a quit flush may run after the player is offline. */
    private final Map<UUID, String> names = new ConcurrentHashMap<>();

    /**
     * One lock for "compute deltas, send, mark as reported". Two flushes (the
     * timer and a player quitting) must never report the same activity twice,
     * so the whole round trip is serialized here.
     */
    private final Object flushLock = new Object();

    private HttpClient http;
    private String claimUrl = "";
    private String statusUrl = "";
    private String emailUrl = "";
    private String statsUrl = "";
    private String panelUrl = "";
    private String serviceToken = "";
    private long cooldownMillis;
    private long statsReportSeconds;
    private Duration requestTimeout = Duration.ofSeconds(10);
    private long lastTickAt = 0;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        loadSettings();

        if (serviceToken.isBlank() || serviceToken.contains("${")) {
            getLogger().severe("service-token is not set, so /website will refuse every request.");
            getLogger().severe("Set LINK_SERVICE_TOKEN in .env.docker and recreate this container; "
                + "scripts/mc-init.sh generates one.");
        }

        http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .version(HttpClient.Version.HTTP_1_1)
            .build();

        if (getCommand("website") != null) {
            getCommand("website").setExecutor(this);
            getCommand("website").setTabCompleter((sender, command, alias, args) -> {
                if (!(sender instanceof Player player) || !isAuthenticated(player)) return List.of();
                if (args.length != 1) return List.of();
                String prefix = args[0].toLowerCase(Locale.ROOT);
                return List.of("link", "email").stream().filter(value -> value.startsWith(prefix)).toList();
            });
        }
        getServer().getPluginManager().registerEvents(this, this);

        lastTickAt = System.currentTimeMillis();
        getServer().getScheduler()
            .runTaskTimerAsynchronously(this, this::tickPlayTime, PLAY_TICK_TICKS, PLAY_TICK_TICKS);
        getServer().getScheduler()
            .runTaskTimerAsynchronously(this, () -> flush(null, requestTimeout),
                statsReportSeconds * 20L, statsReportSeconds * 20L);
    }

    @Override
    public void onDisable() {
        // One last attempt so a restart does not lose this run's activity. A short
        // timeout keeps the shutdown quick when the panel is down.
        try {
            flush(null, Duration.ofSeconds(3));
        } catch (Exception ignored) {
            // Nothing useful to do on the way down.
        }
        try {
            if (http instanceof AutoCloseable closeable) {
                closeable.close();
            }
        } catch (Exception ignored) {
            // Nothing useful to do on the way down.
        }
    }

    private void loadSettings() {
        String base = getConfig().getString("api-base", "http://app:8080");
        base = base == null ? "" : base.trim().replaceAll("/+$", "");
        claimUrl = base + "/internal/link/claim";
        statusUrl = base + "/internal/link/status";
        emailUrl = base + "/internal/link/email";
        statsUrl = base + "/internal/stats/report";

        String panel = getConfig().getString("panel-url", "");
        panelUrl = panel == null ? "" : panel.trim();

        String token = getConfig().getString("service-token", "");
        serviceToken = token == null ? "" : token.trim();

        cooldownMillis = Math.max(0, getConfig().getInt("cooldown-seconds", 3)) * 1000L;
        statsReportSeconds = Math.max(1, getConfig().getInt("stats-report-seconds", 300));
        requestTimeout = Duration.ofSeconds(Math.max(1, getConfig().getInt("timeout-seconds", 10)));
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage(PREFIX + "This command can only be used in game.");
            return true;
        }

        // Second half of the gate. AuthMe already refuses every command that is
        // not in settings.restrictions.allowCommands while a player is not
        // authenticated, and /website is deliberately absent from that list — but an
        // authorisation decision must never rest on a config file alone.
        if (!isAuthenticated(player)) {
            player.sendMessage(PREFIX + "Log in first, then try again.");
            return true;
        }

        boolean emailRequest = args.length == 1 && args[0].equalsIgnoreCase("email");
        boolean linkRequest = args.length == 2 && args[0].equalsIgnoreCase("link");
        if (!emailRequest && !linkRequest) {
            player.sendMessage(PREFIX + "Usage: /website link <code> or /website email");
            player.sendMessage(PREFIX + "Get a code on the website, then type it here.");
            return true;
        }

        if (serviceToken.isBlank() || serviceToken.contains("${")) {
            player.sendMessage(PREFIX + "Website commands are not configured on this server.");
            return true;
        }

        String code = linkRequest ? args[1].trim().toUpperCase(Locale.ROOT) : "";
        if (linkRequest && (code.isEmpty() || code.length() > 32)) {
            player.sendMessage(PREFIX + "That does not look like a link code.");
            return true;
        }

        UUID uuid = player.getUniqueId();
        if (!allowAttempt(uuid)) {
            player.sendMessage(PREFIX + "Too many attempts. Wait a few seconds and try again.");
            return true;
        }

        String uuidText = uuid.toString();
        String username = player.getName();

        player.sendMessage(PREFIX + (emailRequest ? "Checking your linked website email..." : "Checking that code..."));

        // Network I/O must never run on the server thread.
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            HttpResponse<String> emailResponse = emailRequest
                ? post(emailUrl, "{\"uuid\":\"" + jsonEscape(uuidText) + "\"}", requestTimeout)
                : null;
            int status = emailRequest
                ? (emailResponse == null ? -1 : emailResponse.statusCode())
                : claim(code, uuidText, username);
            String hint = emailResponse == null ? "" : emailResponse.body().trim();
            try {
                if (!isEnabled()) {
                    return;
                }
                getServer().getScheduler().runTask(this, () -> {
                    // Do not deliver a private hint after logout or disconnect.
                    if (!player.isOnline() || !isAuthenticated(player)) return;
                    if (emailRequest) respondEmail(player, status, hint);
                    else respond(player, status);
                });
            } catch (Exception ignored) {
                // The plugin is shutting down; the player keeps the "checking" line.
            }
        });

        return true;
    }

    // --- Telling unlinked players where to go ---------------------------------

    /**
     * AuthMe fires these the moment a player is authenticated, which is the first
     * point at which a nudge is both useful and visible: before that the player is
     * still behind the pre-join dialog, and after it they are already in the world.
     */
    @EventHandler(priority = EventPriority.MONITOR)
    public void onLogin(LoginEvent event) {
        announce(event.getPlayer());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onRegister(RegisterEvent event) {
        announce(event.getPlayer());
    }

    private void announce(Player player) {
        if (!isEnabled() || player == null || !player.isOnline()) {
            return;
        }
        // With no site to send them to, saying nothing beats sending them nowhere.
        if (panelUrl.isBlank() || panelUrl.contains("${")) {
            return;
        }
        if (serviceToken.isBlank() || serviceToken.contains("${")) {
            return;
        }

        String uuid = player.getUniqueId().toString();
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            int status = status(uuid);
            switch (status) {
                case 404 -> {
                    // The one case worth speaking up about: not linked yet.
                }
                case 200 -> {
                    return; // Already linked. Never nag.
                }
                case 401, 503 -> {
                    // A configuration fault. The player cannot fix it and does not
                    // need to know, but an operator does.
                    getLogger().warning("The panel refused the link status check (" + status
                        + "). Check LINK_SERVICE_TOKEN and that the panel is running.");
                    return;
                }
                default -> {
                    // Unreachable panel, or anything unexpected. Silence: this is a
                    // courtesy, and a wrong "you are not linked" would be worse than
                    // no message at all.
                    return;
                }
            }
            try {
                getServer().getScheduler().runTask(this, () -> notice(player));
            } catch (Exception ignored) {
                // The plugin is shutting down.
            }
        });
    }

    private void notice(Player player) {
        if (!isEnabled() || !player.isOnline()) {
            return;
        }
        // The client turns a bare http(s) URL in chat into a link, so this needs no
        // click-event machinery and no dependency beyond the game itself.
        player.sendMessage(PREFIX + "This Minecraft account is not linked to a website account yet.");
        player.sendMessage(PREFIX + "Get a code at " + panelUrl + ", then type /website link <code> here.");
    }

    // --- Measuring and reporting statistics -----------------------------------

    /**
     * Fails closed, like the /website gate: until AuthMe has proved who the player
     * is, their activity is not credited to the linked account.
     */
    private boolean isAuthenticated(Player player) {
        AuthMeApi authMe = AuthMeApi.getInstance();
        return authMe != null && authMe.isAuthenticated(player);
    }

    /**
     * Adds the time since the last tick to every player who is online and
     * authenticated. The elapsed time is measured, not assumed, so a slow
     * server neither over- nor under-counts.
     */
    private void tickPlayTime() {
        long now = System.currentTimeMillis();
        long seconds = (now - lastTickAt) / 1000L;
        lastTickAt = now;
        if (seconds <= 0) {
            return;
        }
        for (Player player : getServer().getOnlinePlayers()) {
            if (isAuthenticated(player)) {
                countersFor(player).playSeconds.addAndGet(seconds);
            }
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onBlockPlaced(BlockPlaceEvent event) {
        Player player = event.getPlayer();
        if (!isAuthenticated(player)) {
            return;
        }
        countersFor(player).blocksPlaced.incrementAndGet();
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onBlockBroken(BlockBreakEvent event) {
        Player player = event.getPlayer();
        // MONITOR is the last word on the event, so the cancellation decision is final.
        if (!isAuthenticated(player) || event.isCancelled()) {
            return;
        }
        countersFor(player).blocksBroken.incrementAndGet();
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerQuit(PlayerQuitEvent event) {
        UUID uuid = event.getPlayer().getUniqueId();
        // A quit is a good moment to hand in the pending activity, so "last active"
        // in the panel tracks the disconnect. The panel may be unreachable; the
        // periodic flush still owns the data.
        getServer().getScheduler().runTaskAsynchronously(this, () -> flush(uuid, requestTimeout));
    }

    private Counters countersFor(Player player) {
        names.put(player.getUniqueId(), player.getName());
        return totals.computeIfAbsent(player.getUniqueId(), id -> new Counters());
    }

    /**
     * Reports, for one player (or every player when {@code only} is null), the
     * activity measured since the panel last accepted a report for that player.
     *
     * <p>Compute, send, and mark-as-reported happen under one lock, so the timer
     * flush and a quit flush can never hand the panel the same activity twice.
     * When the panel does not answer 200 the delta is kept and retried by the
     * next flush; a hard shutdown loses at most the activity measured since the
     * last accepted report.
     */
    private void flush(UUID only, Duration timeout) {
        if (!isEnabled() || statsUrl.isBlank()) {
            return;
        }
        synchronized (flushLock) {
            List<Delta> batch = pendingDeltas(only);
            if (batch.isEmpty()) {
                return;
            }
            int status = report(batch, timeout);
            if (status != 200) {
                return;
            }
            markReported(batch);
        }
    }

    private List<Delta> pendingDeltas(UUID only) {
        List<Delta> batch = new ArrayList<>();
        for (Map.Entry<UUID, Counters> entry : totals.entrySet()) {
            if (only != null && !entry.getKey().equals(only)) {
                continue;
            }
            Counters total = entry.getValue();
            Counters sent = reported.getOrDefault(entry.getKey(), new Counters());
            long play = total.playSeconds.get() - sent.playSeconds.get();
            long placed = total.blocksPlaced.get() - sent.blocksPlaced.get();
            long broken = total.blocksBroken.get() - sent.blocksBroken.get();
            if (play <= 0 && placed <= 0 && broken <= 0) {
                continue;
            }
            String username = names.get(entry.getKey());
            if (username == null || username.isBlank()) {
                // No name, no report: a blank username would fail the panel's
                // validation for the whole batch. Retried on the next flush.
                continue;
            }
            batch.add(new Delta(entry.getKey(), username,
                Math.max(0, play), Math.max(0, placed), Math.max(0, broken)));
        }
        return batch;
    }

    private void markReported(List<Delta> batch) {
        for (Delta delta : batch) {
            Counters sent = reported.computeIfAbsent(delta.uuid(), id -> new Counters());
            sent.playSeconds.addAndGet(delta.playSeconds());
            sent.blocksPlaced.addAndGet(delta.blocksPlaced());
            sent.blocksBroken.addAndGet(delta.blocksBroken());
        }
    }

    /**
     * Sends one batched report and returns the HTTP status, or {@code -1} when
     * the panel could not be reached. Activity the panel refused is retried by
     * the next flush, so a transient failure costs nothing but freshness.
     */
    private int report(List<Delta> batch, Duration timeout) {
        StringBuilder body = new StringBuilder("{\"players\":[");
        for (int i = 0; i < batch.size(); i++) {
            Delta delta = batch.get(i);
            if (i > 0) {
                body.append(',');
            }
            body.append("{\"uuid\":\"").append(jsonEscape(delta.uuid().toString()))
                .append("\",\"username\":\"").append(jsonEscape(delta.username()))
                .append("\",\"play_seconds\":").append(delta.playSeconds())
                .append(",\"blocks_placed\":").append(delta.blocksPlaced())
                .append(",\"blocks_broken\":").append(delta.blocksBroken()).append('}');
        }
        body.append("]}");
        HttpResponse<String> response = post(statsUrl, body.toString(), timeout);
        if (response != null && response.statusCode() != 200) {
            String problem = switch (response.statusCode()) {
                case 401, 503 -> "the panel refused this server's credentials ("
                    + response.statusCode() + "). Check LINK_SERVICE_TOKEN and that the panel is running.";
                default -> "the panel answered " + response.statusCode() + ".";
            };
            getLogger().warning("The statistics report was not accepted: " + problem);
        } else if (response == null) {
            getLogger().warning("The statistics report was not sent: the panel could not be reached. "
                + "The activity will be retried on the next flush.");
        }
        return response == null ? -1 : response.statusCode();
    }

    /**
     * Per-player activity measured since plugin start. The tick task (an async
     * scheduler thread), the block handlers (the main thread), and the flush
     * (another async thread or the main thread on shutdown) all touch it, so
     * every counter is atomic.
     */
    private static final class Counters {
        private final AtomicLong playSeconds = new AtomicLong();
        private final AtomicLong blocksPlaced = new AtomicLong();
        private final AtomicLong blocksBroken = new AtomicLong();
    }

    private record Delta(UUID uuid, String username, long playSeconds, long blocksPlaced, long blocksBroken) {
    }

    // --- Panel calls ----------------------------------------------------------

    /**
     * Allows one attempt per player per cooldown window. Every player reaches the
     * panel from the same source address (this container), so the panel's per-IP
     * claim budget is shared by the whole server — an unmetered /website would let a
     * single player spend all of it.
     */
    private boolean allowAttempt(UUID uuid) {
        if (cooldownMillis <= 0) {
            return true;
        }
        long now = System.currentTimeMillis();
        lastAttempt.entrySet().removeIf(entry -> now - entry.getValue() >= cooldownMillis);
        return lastAttempt.putIfAbsent(uuid, now) == null;
    }

    /**
     * {@code 200} when the UUID is linked, {@code 404} when it is not; the panel
     * answers both endpoints with a bare status code, so this never parses JSON.
     * Returns {@code -1} when the panel could not be reached at all.
     */
    private int status(String uuid) {
        HttpResponse<String> response = post(statusUrl, "{\"uuid\":\"" + jsonEscape(uuid) + "\"}", requestTimeout);
        return response == null ? -1 : response.statusCode();
    }

    private int claim(String code, String uuid, String username) {
        String body = "{\"code\":\"" + jsonEscape(code) + "\""
            + ",\"uuid\":\"" + jsonEscape(uuid) + "\""
            + ",\"username\":\"" + jsonEscape(username) + "\"}";
        HttpResponse<String> response = post(claimUrl, body, requestTimeout);
        return response == null ? -1 : response.statusCode();
    }

    /**
     * POSTs a JSON body and returns the response, or null when the panel could not
     * be reached. Everything is inside the try so that a malformed URL, a bad header
     * or a dead panel all end in a reply rather than in a player staring at
     * "Checking that code..." forever. The token travels as a header, so it never
     * appears in a log line.
     */
    private HttpResponse<String> post(String url, String body, Duration timeout) {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(timeout)
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + serviceToken)
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build();

            return http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } catch (Exception e) {
            getLogger().warning("Could not reach the panel at " + url + ": " + e);
            return null;
        }
    }

    private void respond(Player player, int status) {
        if (!isEnabled()) {
            return;
        }
        String message = switch (status) {
            case 200 -> "Linked! This Minecraft account now belongs to your panel account.";
            case 400 -> "The panel rejected that request.";
            case 401 -> "The panel refused this server's credentials. Tell an administrator.";
            case 404 -> "That code is unknown, already used, or expired. Codes are valid for 5 minutes.";
            case 409 -> "This Minecraft account is already linked to a panel account.";
            case 503 -> "Linking is switched off on this server. Tell an administrator.";
            case -1 -> "Could not reach the panel. Try again in a moment.";
            default -> "Unexpected answer from the panel (" + status + ").";
        };
        player.sendMessage(PREFIX + message);
    }

    private void respondEmail(Player player, int status, String hint) {
        // The server already masks the address. Never echo an unexpected body
        // into chat, and never log the address or broadcast it to other players.
        if (status == 200 && hint.matches("[A-Za-z0-9]?\\*{3}@[A-Za-z0-9.-]+")) {
            player.sendMessage(PREFIX + "Your linked website email: " + hint);
            return;
        }
        String message = switch (status) {
            case 404 -> "This Minecraft account is not linked to a website account yet.";
            case 401, 503 -> "Website commands are unavailable. Tell an administrator.";
            case -1 -> "Could not reach the website. Try again in a moment.";
            default -> "Could not look up your linked website email. Try again later.";
        };
        player.sendMessage(PREFIX + message);
    }

    private static String jsonEscape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
