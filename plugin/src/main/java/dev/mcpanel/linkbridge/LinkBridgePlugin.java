package dev.mcpanel.linkbridge;

import fr.xephi.authme.api.v3.AuthMeApi;
import fr.xephi.authme.events.LoginEvent;
import fr.xephi.authme.events.RegisterEvent;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.bukkit.Location;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.enchantment.EnchantItemEvent;
import org.bukkit.event.entity.EntityBreedEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityDeathEvent;
import org.bukkit.event.entity.EntityPickupItemEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.inventory.CraftItemEvent;
import org.bukkit.event.player.PlayerAdvancementDoneEvent;
import org.bukkit.event.player.PlayerBedEnterEvent;
import org.bukkit.event.player.PlayerBedLeaveEvent;
import org.bukkit.event.player.PlayerFishEvent;
import org.bukkit.event.player.PlayerItemBreakEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.inventory.ItemStack;
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
 * <p>The plugin also measures in-game activity — time online, blocks placed and
 * broken, mobs killed, deaths, distance travelled, items crafted and picked up,
 * fish caught, damage dealt and taken, logins, enchantments, broken tools,
 * animals bred, times slept and advancements earned — and reports the growth
 * since the panel last accepted a report to {@code /internal/stats/report}, so
 * the panel can show per-account statistics. Only events that actually happened
 * are counted: a cancelled break, a teleport, or a look-around that moves nobody
 * adds nothing. Activity only counts after AuthMe has authenticated the player:
 * before that they are standing at the login gate, not playing.
 */
public final class LinkBridgePlugin extends JavaPlugin implements CommandExecutor, Listener {

    private static final String PREFIX = "[Link] ";

    /** Ten server ticks: how often play time is sampled into the counters. */
    private static final long PLAY_TICK_TICKS = 200L;

    /**
     * A single move event longer than this is a teleport, a portal, or a server
     * correction — not walking. Counting it as distance would invent travel.
     */
    private static final double MAX_WALK_BLOCKS = 8.0;

    /** Player UUID to the epoch millisecond of their last /website attempt. */
    private final Map<UUID, Long> lastAttempt = new ConcurrentHashMap<>();

    /** Players who entered a bed and have not left it yet, for the sleep counter. */
    private final Set<UUID> sleeping = ConcurrentHashMap.newKeySet();

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
    private String balanceUrl = "";
    private String skinsSyncUrl = "";
    private String skinsReportUrl = "";
    private final java.util.concurrent.atomic.AtomicBoolean skinSyncRunning = new java.util.concurrent.atomic.AtomicBoolean();
    private String pendingBody;
    private List<Delta> pendingBatch = List.of();
    private Path outbox;
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
        outbox = getDataFolder().toPath().resolve("pending-report.json");
        try {
            if (Files.exists(outbox)) pendingBody = Files.readString(outbox);
        } catch (IOException error) {
            throw new IllegalStateException("Cannot read pending coin report; refusing to risk losing it", error);
        }

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
        if (getCommand("balance") != null) {
            getCommand("balance").setExecutor(this);
            getCommand("balance").setTabCompleter((sender, command, alias, args) -> List.of());
        }
        getServer().getPluginManager().registerEvents(this, this);
        getServer().getScheduler().runTaskTimerAsynchronously(this, this::syncSkins, 40L, 100L);

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
        balanceUrl = base + "/internal/balance";
        skinsSyncUrl = base + "/internal/skins/sync";
        skinsReportUrl = base + "/internal/skins/report";

        String panel = getConfig().getString("panel-url", "");
        panelUrl = panel == null ? "" : panel.trim();

        String token = getConfig().getString("service-token", "");
        serviceToken = token == null ? "" : token.trim();

        cooldownMillis = Math.max(0, getConfig().getInt("cooldown-seconds", 3)) * 1000L;
        statsReportSeconds = Math.max(1, getConfig().getInt("stats-report-seconds", 5));
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

        if (command.getName().equalsIgnoreCase("balance")) {
            if (args.length != 0) {
                player.sendMessage("[Coins] Usage: /bal or /balance");
                return true;
            }
            showBalance(player);
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

    private void showBalance(Player player) {
        UUID uuid = player.getUniqueId();
        if (!allowAttempt(uuid)) {
            player.sendMessage("[Coins] Wait a few seconds and try again.");
            return;
        }
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            String message = "[Coins] Balance unavailable. Try again shortly.";
            // Flush this player's earnings before reading the shared balance. If
            // synchronisation fails, never show a plausible but stale number.
            synchronized (flushLock) {
                if (flush(uuid, requestTimeout)) {
                    HttpResponse<String> response = post(balanceUrl,
                        "{\"uuid\":\"" + uuid + "\"}", requestTimeout);
                    if (response != null && response.statusCode() == 200) {
                        try {
                            long coins = Long.parseLong(response.body().trim());
                            if (coins >= 0) message = "[Coins] Balance: " + coins + " coins.";
                        } catch (NumberFormatException ignored) { }
                    }
                }
            }
            String reply = message;
            try {
                if (isEnabled()) getServer().getScheduler().runTask(this, () -> {
                    if (player.isOnline() && isAuthenticated(player)) player.sendMessage(reply);
                });
            } catch (Exception ignored) { }
        });
    }

    // --- Telling unlinked players where to go ---------------------------------

    /**
     * AuthMe fires these the moment a player is authenticated, which is the first
     * point at which a nudge is both useful and visible: before that the player is
     * still behind the pre-join dialog, and after it they are already in the world.
     */
    @EventHandler(priority = EventPriority.MONITOR)
    public void onLogin(LoginEvent event) {
        countLogin(event.getPlayer());
        announce(event.getPlayer());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onRegister(RegisterEvent event) {
        countLogin(event.getPlayer());
        announce(event.getPlayer());
    }

    /**
     * One authenticated session. Registering counts too: the player is now in the
     * world under the identity the panel will be told about.
     */
    private void countLogin(Player player) {
        if (player != null && isAuthenticated(player)) {
            countersFor(player).logins.incrementAndGet();
        }
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

    /**
     * Walking, flying, swimming and sprinting all move the player between block
     * positions. Look-around moves fire the same event with an unchanged block
     * position, so those add nothing. A jump over the 8-block cap is a teleport
     * or portal, not travel, so it is skipped rather than counted as a detour.
     */
    @EventHandler(priority = EventPriority.MONITOR)
    public void onMove(PlayerMoveEvent event) {
        Location from = event.getFrom();
        Location to = event.getTo();
        if (to == null) {
            return;
        }
        if (
            from.getBlockX() == to.getBlockX()
                && from.getBlockY() == to.getBlockY()
                && from.getBlockZ() == to.getBlockZ()
        ) {
            return;
        }
        double blocks = from.distance(to);
        if (blocks <= 0.0 || blocks > MAX_WALK_BLOCKS) {
            return;
        }
        Player player = event.getPlayer();
        if (!isAuthenticated(player)) {
            return;
        }
        // Centi-blocks: a walk of a fraction of a block must still count, and an
        // integer counter survives the flush retries without losing the fraction.
        countersFor(player).distanceCm.addAndGet(Math.round(blocks * 100.0));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onEntityDeath(EntityDeathEvent event) {
        Player killer = event.getEntity().getKiller();
        if (killer != null && isAuthenticated(killer)) {
            countersFor(killer).mobsKilled.incrementAndGet();
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerDeath(PlayerDeathEvent event) {
        Player player = event.getEntity();
        if (isAuthenticated(player)) {
            countersFor(player).deaths.incrementAndGet();
        }
    }

    /** Damage the player lands on something: melee, projectile, mobs they punch. */
    @EventHandler(priority = EventPriority.MONITOR)
    public void onDamageDealt(EntityDamageByEntityEvent event) {
        if (!(event.getDamager() instanceof Player player) || !isAuthenticated(player)) {
            return;
        }
        if (event.isCancelled() || event.getFinalDamage() <= 0.0) {
            return;
        }
        countersFor(player).damageDealt.addAndGet(centiHearts(event.getFinalDamage()));
    }

    /** Damage that lands on the player, whatever the cause. */
    @EventHandler(priority = EventPriority.MONITOR)
    public void onDamageTaken(EntityDamageEvent event) {
        if (!(event.getEntity() instanceof Player player) || !isAuthenticated(player)) {
            return;
        }
        if (event.isCancelled() || event.getFinalDamage() <= 0.0) {
            return;
        }
        countersFor(player).damageTaken.addAndGet(centiHearts(event.getFinalDamage()));
    }

    /** The damage the game finally applied, in hundredths of a heart. */
    private long centiHearts(double damagePoints) {
        // One damage point is half a heart, so 100 centi-hearts per 2 points.
        return Math.max(0L, Math.round(damagePoints * 50.0));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onCraft(CraftItemEvent event) {
        Player player = event.getWhoClicked() instanceof Player who ? who : null;
        if (player == null || !isAuthenticated(player)) {
            return;
        }
        ItemStack result = event.getRecipe().getResult();
        if (result != null) {
            countersFor(player).itemsCrafted.addAndGet(result.getAmount());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPickup(EntityPickupItemEvent event) {
        if (!(event.getEntity() instanceof Player player) || !isAuthenticated(player)) {
            return;
        }
        countersFor(player).itemsPickedUp.addAndGet(event.getItem().getItemStack().getAmount());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onCatch(PlayerFishEvent event) {
        if (event.getState() != PlayerFishEvent.State.CAUGHT_FISH) {
            return;
        }
        Player player = event.getPlayer();
        if (isAuthenticated(player)) {
            countersFor(player).fishCaught.incrementAndGet();
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onEnchant(EnchantItemEvent event) {
        Player player = event.getEnchanter();
        if (isAuthenticated(player)) {
            countersFor(player).itemsEnchanted.incrementAndGet();
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onToolBreak(PlayerItemBreakEvent event) {
        Player player = event.getPlayer();
        if (isAuthenticated(player)) {
            countersFor(player).toolsBroken.incrementAndGet();
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onBreed(EntityBreedEvent event) {
        if (!(event.getBreeder() instanceof Player player) || !isAuthenticated(player)) {
            return;
        }
        countersFor(player).animalsBred.incrementAndGet();
    }

    /**
     * A sleep is an entry into a bed the game accepted (right-click at night or
     * with a sunrise to follow) and a later exit. Entering a bed during the day
     * is answered with a refusal, and that is not sleeping, so it is not counted.
     */
    @EventHandler(priority = EventPriority.MONITOR)
    public void onBedEnter(PlayerBedEnterEvent event) {
        Player player = event.getPlayer();
        if (event.getBedEnterResult() != PlayerBedEnterEvent.BedEnterResult.OK) {
            return;
        }
        if (isAuthenticated(player)) {
            sleeping.add(player.getUniqueId());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onBedLeave(PlayerBedLeaveEvent event) {
        Player player = event.getPlayer();
        if (isAuthenticated(player) && sleeping.remove(player.getUniqueId())) {
            countersFor(player).timesSlept.incrementAndGet();
        }
    }

    /** Only player-visible advances count; recipe unlocks are hidden advancements. */
    @EventHandler(priority = EventPriority.MONITOR)
    public void onAdvancement(PlayerAdvancementDoneEvent event) {
        Player player = event.getPlayer();
        if (event.getAdvancement().getDisplay() == null) {
            return;
        }
        if (isAuthenticated(player)) {
            countersFor(player).advancements.incrementAndGet();
        }
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
    private boolean flush(UUID only, Duration timeout) {
        if (statsUrl.isBlank()) return false;
        synchronized (flushLock) {
            // On restart this body is recovered from disk, with no in-memory
            // counters to mark. Retries always reuse the exact body and ID.
            if (pendingBody != null && !sendPending(timeout)) return false;
            List<Delta> batch = pendingDeltas(only);
            for (int start = 0; start < batch.size(); start += 1000) {
                pendingBatch = new ArrayList<>(batch.subList(start, Math.min(start + 1000, batch.size())));
                String body = reportBody(pendingBatch);
                try {
                    Path temporary = outbox.resolveSibling("pending-report.tmp");
                    Files.writeString(temporary, body);
                    Files.move(temporary, outbox, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                    pendingBody = body;
                } catch (IOException error) {
                    getLogger().warning("Cannot save coin report; activity remains pending: " + error);
                    pendingBatch = List.of();
                    return false;
                }
                if (!sendPending(timeout)) return false;
            }
            return true;
        }
    }

    private boolean sendPending(Duration timeout) {
        HttpResponse<String> response = post(statsUrl, pendingBody, timeout);
        if (response == null || response.statusCode() != 200) return false;
        try {
            Files.deleteIfExists(outbox);
        } catch (IOException error) {
            getLogger().warning("Cannot clear accepted coin report; will safely retry: " + error);
            return false;
        }
        markReported(pendingBatch);
        pendingBatch = List.of();
        pendingBody = null;
        return true;
    }

    private List<Delta> pendingDeltas(UUID only) {
        List<Delta> batch = new ArrayList<>();
        for (Map.Entry<UUID, Counters> entry : totals.entrySet()) {
            if (only != null && !entry.getKey().equals(only)) {
                continue;
            }
            Counters total = entry.getValue();
            Counters sent = reported.getOrDefault(entry.getKey(), new Counters());
            Delta delta = new Delta(entry.getKey(), null,
                Math.max(0, total.playSeconds.get() - sent.playSeconds.get()),
                Math.max(0, total.blocksPlaced.get() - sent.blocksPlaced.get()),
                Math.max(0, total.blocksBroken.get() - sent.blocksBroken.get()),
                Math.max(0, total.mobsKilled.get() - sent.mobsKilled.get()),
                Math.max(0, total.deaths.get() - sent.deaths.get()),
                Math.max(0, total.distanceCm.get() - sent.distanceCm.get()),
                Math.max(0, total.itemsCrafted.get() - sent.itemsCrafted.get()),
                Math.max(0, total.fishCaught.get() - sent.fishCaught.get()),
                Math.max(0, total.damageDealt.get() - sent.damageDealt.get()),
                Math.max(0, total.damageTaken.get() - sent.damageTaken.get()),
                Math.max(0, total.logins.get() - sent.logins.get()),
                Math.max(0, total.itemsPickedUp.get() - sent.itemsPickedUp.get()),
                Math.max(0, total.itemsEnchanted.get() - sent.itemsEnchanted.get()),
                Math.max(0, total.toolsBroken.get() - sent.toolsBroken.get()),
                Math.max(0, total.animalsBred.get() - sent.animalsBred.get()),
                Math.max(0, total.timesSlept.get() - sent.timesSlept.get()),
                Math.max(0, total.advancements.get() - sent.advancements.get()));
            if (delta.isEmpty()) {
                continue;
            }
            String username = names.get(entry.getKey());
            if (username == null || username.isBlank()) {
                // No name, no report: a blank username would fail the panel's
                // validation for the whole batch. Retried on the next flush.
                continue;
            }
            batch.add(delta.withUsername(username));
        }
        return batch;
    }

    private void markReported(List<Delta> batch) {
        for (Delta delta : batch) {
            Counters sent = reported.computeIfAbsent(delta.uuid(), id -> new Counters());
            sent.playSeconds.addAndGet(delta.playSeconds());
            sent.blocksPlaced.addAndGet(delta.blocksPlaced());
            sent.blocksBroken.addAndGet(delta.blocksBroken());
            sent.mobsKilled.addAndGet(delta.mobsKilled());
            sent.deaths.addAndGet(delta.deaths());
            sent.distanceCm.addAndGet(delta.distanceCm());
            sent.itemsCrafted.addAndGet(delta.itemsCrafted());
            sent.fishCaught.addAndGet(delta.fishCaught());
            sent.damageDealt.addAndGet(delta.damageDealt());
            sent.damageTaken.addAndGet(delta.damageTaken());
            sent.logins.addAndGet(delta.logins());
            sent.itemsPickedUp.addAndGet(delta.itemsPickedUp());
            sent.itemsEnchanted.addAndGet(delta.itemsEnchanted());
            sent.toolsBroken.addAndGet(delta.toolsBroken());
            sent.animalsBred.addAndGet(delta.animalsBred());
            sent.timesSlept.addAndGet(delta.timesSlept());
            sent.advancements.addAndGet(delta.advancements());
        }
    }

    /**
     * Serializes one immutable batch, including the ID used for safe retries.
     * The three counters the panel has known since migration 0005 are always
     * written; the wider 0008 fields follow, so an older panel still parses the
     * report, and a newer panel tolerates a report from an older plugin.
     */
    private String reportBody(List<Delta> batch) {
        StringBuilder body = new StringBuilder("{\"report_id\":\"" + UUID.randomUUID() + "\",\"players\":[");
        for (int i = 0; i < batch.size(); i++) {
            Delta delta = batch.get(i);
            if (i > 0) {
                body.append(',');
            }
            body.append("{\"uuid\":\"").append(jsonEscape(delta.uuid().toString()))
                .append("\",\"username\":\"").append(jsonEscape(delta.username()))
                .append("\",\"play_seconds\":").append(delta.playSeconds())
                .append(",\"blocks_placed\":").append(delta.blocksPlaced())
                .append(",\"blocks_broken\":").append(delta.blocksBroken())
                .append(",\"mobs_killed\":").append(delta.mobsKilled())
                .append(",\"deaths\":").append(delta.deaths())
                .append(",\"distance_cm\":").append(delta.distanceCm())
                .append(",\"items_crafted\":").append(delta.itemsCrafted())
                .append(",\"fish_caught\":").append(delta.fishCaught())
                .append(",\"damage_dealt\":").append(delta.damageDealt())
                .append(",\"damage_taken\":").append(delta.damageTaken())
                .append(",\"logins\":").append(delta.logins())
                .append(",\"items_picked_up\":").append(delta.itemsPickedUp())
                .append(",\"items_enchanted\":").append(delta.itemsEnchanted())
                .append(",\"tools_broken\":").append(delta.toolsBroken())
                .append(",\"animals_bred\":").append(delta.animalsBred())
                .append(",\"times_slept\":").append(delta.timesSlept())
                .append(",\"advancements\":").append(delta.advancements()).append('}');
        }
        body.append("]}");
        return body.toString();
    }

    /**
     * Per-player activity measured since plugin start. The tick task (an async
     * scheduler thread), the block handlers (the main thread), and the flush
     * (another async thread or the main thread on shutdown) all touch it, so
     * every counter is atomic.
     *
     * <p>Distance is centi-blocks and damage is centi-hearts so fractional
     * activity never rounds to zero between flushes; the panel stores exactly
     * what is reported and the website converts for display.
     */
    private static final class Counters {
        private final AtomicLong playSeconds = new AtomicLong();
        private final AtomicLong blocksPlaced = new AtomicLong();
        private final AtomicLong blocksBroken = new AtomicLong();
        private final AtomicLong mobsKilled = new AtomicLong();
        private final AtomicLong deaths = new AtomicLong();
        private final AtomicLong distanceCm = new AtomicLong();
        private final AtomicLong itemsCrafted = new AtomicLong();
        private final AtomicLong fishCaught = new AtomicLong();
        private final AtomicLong damageDealt = new AtomicLong();
        private final AtomicLong damageTaken = new AtomicLong();
        private final AtomicLong logins = new AtomicLong();
        private final AtomicLong itemsPickedUp = new AtomicLong();
        private final AtomicLong itemsEnchanted = new AtomicLong();
        private final AtomicLong toolsBroken = new AtomicLong();
        private final AtomicLong animalsBred = new AtomicLong();
        private final AtomicLong timesSlept = new AtomicLong();
        private final AtomicLong advancements = new AtomicLong();
    }

    /**
     * The growth for one player since the last accepted report. The username is
     * filled in before the batch is sent, because a player measured before they
     * are named must wait for the name rather than ship a report the panel would
     * reject; the accessors the flush uses do not require the name yet.
     */
    private record Delta(
        UUID uuid,
        String username,
        long playSeconds,
        long blocksPlaced,
        long blocksBroken,
        long mobsKilled,
        long deaths,
        long distanceCm,
        long itemsCrafted,
        long fishCaught,
        long damageDealt,
        long damageTaken,
        long logins,
        long itemsPickedUp,
        long itemsEnchanted,
        long toolsBroken,
        long animalsBred,
        long timesSlept,
        long advancements
    ) {
        boolean isEmpty() {
            return playSeconds <= 0 && blocksPlaced <= 0 && blocksBroken <= 0
                && mobsKilled <= 0 && deaths <= 0 && distanceCm <= 0
                && itemsCrafted <= 0 && fishCaught <= 0 && damageDealt <= 0
                && damageTaken <= 0 && logins <= 0 && itemsPickedUp <= 0
                && itemsEnchanted <= 0 && toolsBroken <= 0 && animalsBred <= 0
                && timesSlept <= 0 && advancements <= 0;
        }

        Delta withUsername(String name) {
            return new Delta(uuid, name, playSeconds, blocksPlaced, blocksBroken,
                mobsKilled, deaths, distanceCm, itemsCrafted, fishCaught,
                damageDealt, damageTaken, logins, itemsPickedUp, itemsEnchanted,
                toolsBroken, animalsBred, timesSlept, advancements);
        }
    }

    /** Read and save skin choices off-thread; touch live Player objects only on the server thread. */
    private void syncSkins() {
        if (!skinSyncRunning.compareAndSet(false, true)) return;
        try {
            HttpResponse<String> response = post(skinsSyncUrl, "{}", requestTimeout);
            if (response == null || response.statusCode() != 200 || response.body().length() > 1024 * 1024) return;
            var skins = net.skinsrestorer.api.SkinsRestorerProvider.get();
            var tasks = com.google.gson.JsonParser.parseString(response.body()).getAsJsonArray();
            for (var item : tasks) {
                try {
                    var task = item.getAsJsonObject();
                    UUID uuid = UUID.fromString(task.get("uuid").getAsString());
                    String username = task.get("username").getAsString();
                    String requestId = task.get("request_id").isJsonNull() ? null : task.get("request_id").getAsString();
                    net.skinsrestorer.api.property.SkinProperty property;
                    if (requestId != null) {
                        property = net.skinsrestorer.api.property.SkinProperty.of(
                            task.get("value").getAsString(), task.get("signature").getAsString());
                        String name = "panel_" + uuid.toString().replace("-", "");
                        skins.getSkinStorage().setCustomSkinData(name, property);
                        skins.getPlayerStorage().setSkinIdOfPlayer(uuid,
                            net.skinsrestorer.api.property.SkinIdentifier.ofCustom(name));
                        var saved = property;
                        if (isEnabled()) getServer().getScheduler().runTask(this, () -> {
                            Player player = getServer().getPlayer(uuid);
                            if (player != null && player.isOnline() && isAuthenticated(player)) {
                                skins.getSkinApplier(Player.class).applySkin(player, saved);
                            }
                        });
                    } else {
                        property = skins.getPlayerStorage().getSkinForPlayer(uuid, username, false).orElse(null);
                    }
                    String body = "{\"uuid\":\"" + uuid + "\",\"value\":"
                        + (property == null ? "null" : "\"" + jsonEscape(property.getValue()) + "\"")
                        + ",\"request_id\":" + (requestId == null ? "null" : "\"" + jsonEscape(requestId) + "\"") + "}";
                    post(skinsReportUrl, body, requestTimeout);
                } catch (Exception error) {
                    // Keep the pending choice in the panel; the next pass retries.
                    getLogger().warning("Could not synchronize a player skin: " + error.getClass().getSimpleName());
                }
            }
        } catch (Exception error) {
            getLogger().warning("Skin synchronization unavailable: " + error.getClass().getSimpleName());
        } finally { skinSyncRunning.set(false); }
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
