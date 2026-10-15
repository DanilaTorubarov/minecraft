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
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * Redeems a one-time code, issued by the web panel, against the panel's internal
 * {@code /internal/link/claim} endpoint, and points unlinked players at the panel
 * once they have authenticated.
 *
 * <p>The plugin is deliberately dumb: it holds no state about who is linked to
 * what, never sees a password, and never touches the database. The panel is the
 * only source of truth for "which Minecraft account belongs to which panel
 * account". All this plugin does is prove that the player has already
 * authenticated in-game before it vouches for them.
 */
public final class LinkBridgePlugin extends JavaPlugin implements CommandExecutor, Listener {

    private static final String PREFIX = "[Link] ";

    /** Player UUID to the epoch millisecond of their last /link attempt. */
    private final Map<UUID, Long> lastAttempt = new ConcurrentHashMap<>();

    private HttpClient http;
    private String claimUrl = "";
    private String statusUrl = "";
    private String panelUrl = "";
    private String serviceToken = "";
    private long cooldownMillis;
    private Duration requestTimeout = Duration.ofSeconds(10);

    @Override
    public void onEnable() {
        saveDefaultConfig();
        loadSettings();

        if (serviceToken.isBlank() || serviceToken.contains("${")) {
            getLogger().severe("service-token is not set, so /link will refuse every request.");
            getLogger().severe("Set LINK_SERVICE_TOKEN in .env.docker and recreate this container; "
                + "scripts/mc-init.sh generates one.");
        }

        http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .version(HttpClient.Version.HTTP_1_1)
            .build();

        if (getCommand("link") != null) {
            getCommand("link").setExecutor(this);
        }
        getServer().getPluginManager().registerEvents(this, this);
    }

    @Override
    public void onDisable() {
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

        String panel = getConfig().getString("panel-url", "");
        panelUrl = panel == null ? "" : panel.trim();

        String token = getConfig().getString("service-token", "");
        serviceToken = token == null ? "" : token.trim();

        cooldownMillis = Math.max(0, getConfig().getInt("cooldown-seconds", 3)) * 1000L;
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
        // authenticated, and /link is deliberately absent from that list — but an
        // authorisation decision must never rest on a config file alone.
        AuthMeApi authMe = AuthMeApi.getInstance();
        if (authMe == null || !authMe.isAuthenticated(player)) {
            player.sendMessage(PREFIX + "Log in first, then try again.");
            return true;
        }

        if (args.length != 1) {
            player.sendMessage(PREFIX + "Usage: /" + label + " <code>");
            player.sendMessage(PREFIX + "Get a code on the website, then type it here.");
            return true;
        }

        if (serviceToken.isBlank() || serviceToken.contains("${")) {
            player.sendMessage(PREFIX + "Linking is not configured on this server.");
            return true;
        }

        String code = args[0].trim().toUpperCase(Locale.ROOT);
        if (code.isEmpty() || code.length() > 32) {
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

        player.sendMessage(PREFIX + "Checking that code...");

        // Network I/O must never run on the server thread.
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            int status = claim(code, uuidText, username);
            try {
                if (!isEnabled()) {
                    return;
                }
                getServer().getScheduler().runTask(this, () -> respond(player, status));
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
        player.sendMessage(PREFIX + "Get a code at " + panelUrl + ", then type /link <code> here.");
    }

    // --- Panel calls ----------------------------------------------------------

    /**
     * Allows one attempt per player per cooldown window. Every player reaches the
     * panel from the same source address (this container), so the panel's per-IP
     * claim budget is shared by the whole server — an unmetered /link would let a
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
        HttpResponse<String> response = post(statusUrl, "{\"uuid\":\"" + jsonEscape(uuid) + "\"}");
        return response == null ? -1 : response.statusCode();
    }

    private int claim(String code, String uuid, String username) {
        String body = "{\"code\":\"" + jsonEscape(code) + "\""
            + ",\"uuid\":\"" + jsonEscape(uuid) + "\""
            + ",\"username\":\"" + jsonEscape(username) + "\"}";
        HttpResponse<String> response = post(claimUrl, body);
        return response == null ? -1 : response.statusCode();
    }

    /**
     * POSTs a JSON body and returns the response, or null when the panel could not
     * be reached. Everything is inside the try so that a malformed URL, a bad header
     * or a dead panel all end in a reply rather than in a player staring at
     * "Checking that code..." forever. The token travels as a header, so it never
     * appears in a log line.
     */
    private HttpResponse<String> post(String url, String body) {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(requestTimeout)
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

    private static String jsonEscape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
