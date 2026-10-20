package dev.mcpanel.linkbridge;

import fr.xephi.authme.api.v3.AuthMeApi;
import fr.xephi.authme.events.LoginEvent;
import fr.xephi.authme.events.RegisterEvent;
import java.io.InputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;
import java.util.TreeMap;
import java.util.HexFormat;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.enchantments.Enchantment;
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
import org.bukkit.inventory.PlayerInventory;
import org.bukkit.inventory.meta.Damageable;
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
 *
 * <p>Finally, the plugin samples each authenticated player's inventory and
 * reports the latest snapshot — hotbar, main inventory, armor and off hand,
 * with amounts, durability, custom names and enchantments — to
 * {@code /internal/inventory/report}. A snapshot is current state, not a
 * delta: the panel keeps only the newest one. Item textures come straight from
 * the official Minecraft client textures packaged for the server version and are uploaded once per item key to
 * {@code /internal/items/icons}, so an icon always matches the version that
 * produced the snapshot.
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

    /** The latest inventory snapshot the panel accepted, per player UUID. */
    private final Map<UUID, String> inventoryAccepted = new ConcurrentHashMap<>();
    /** Epoch millisecond of the last accepted inventory snapshot, per player UUID. */
    private final Map<UUID, Long> inventoryAcceptedAt = new ConcurrentHashMap<>();
    /** Snapshots waiting for the panel; the newest body per UUID wins. */
    private final Map<UUID, String> inventoryPending = new ConcurrentHashMap<>();
    /** Item keys whose texture the panel has (or will never have) accepted. */
    private final Set<String> iconsAccepted = ConcurrentHashMap.newKeySet();
    /** Item keys queued for a texture upload; failures re-queue on the next sample. */
    private final Set<String> iconsQueued = ConcurrentHashMap.newKeySet();

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
    private String marketplaceUrl = "";
    private String balanceUrl = "";
    private String skinsSyncUrl = "";
    private String skinsReportUrl = "";
    private String inventoryUrl = "";
    private String inventoryDeletesUrl = "";
    private final java.util.concurrent.atomic.AtomicBoolean inventoryFlushRunning = new java.util.concurrent.atomic.AtomicBoolean();
    private String iconsUrl = "";
    private final java.util.concurrent.atomic.AtomicBoolean skinSyncRunning = new java.util.concurrent.atomic.AtomicBoolean();
    private String pendingBody;
    private List<Delta> pendingBatch = List.of();
    private Path outbox;
    private String panelUrl = "";
    private String serviceToken = "";
    private long cooldownMillis;
    private long statsReportSeconds;
    private long inventoryReportSeconds;
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
        if (getCommand("sell") != null) {
            getCommand("sell").setExecutor(this);
            getCommand("sell").setTabCompleter((sender, command, alias, args) -> List.of());
        }
        getServer().getPluginManager().registerEvents(this, this);
        getServer().getScheduler().runTaskTimerAsynchronously(this, this::syncSkins, 40L, 100L);

        initializeEconomy();
        initializeEconomyServices();
        lastTickAt = System.currentTimeMillis();
        getServer().getScheduler()
            .runTaskTimerAsynchronously(this, this::tickPlayTime, PLAY_TICK_TICKS, PLAY_TICK_TICKS);
        getServer().getScheduler()
            .runTaskTimerAsynchronously(this, () -> flush(null, requestTimeout),
                statsReportSeconds * 20L, statsReportSeconds * 20L);
        // Bukkit inventories may only be read on the server thread, so the
        // sampler runs there; the actual HTTP work happens off-thread.
        getServer().getScheduler()
            .runTaskTimer(this, this::snapshotInventories, 100L, 100L);
        getServer().getScheduler()
            .runTaskTimerAsynchronously(this, this::flushInventories, 200L, 200L);
    }

    @Override
    public void onDisable() {
        // One last attempt so a restart does not lose this run's activity. A short
        // timeout keeps the shutdown quick when the panel is down.
        try {
            flush(null, Duration.ofSeconds(3));
            flushEconomy(Duration.ofSeconds(3));
        } catch (Exception ignored) {
            // Nothing useful to do on the way down.
        }
        // Same for inventories: hand in the current snapshot of everyone still
        // online so the panel shows what they were actually carrying. One
        // request per player, so the whole pass is bounded by a deadline
        // instead of multiplying a timeout by the number of players; the
        // background sender would have caught them otherwise.
        try {
            if (!inventoryUrl.isBlank()) {
                long deadline = System.currentTimeMillis() + 3000;
                for (Player player : getServer().getOnlinePlayers()) {
                    if (System.currentTimeMillis() >= deadline) {
                        break;
                    }
                    if (!isAuthenticated(player)) {
                        continue;
                    }
                    post(inventoryUrl, inventorySnapshot(player), Duration.ofSeconds(1));
                }
            }
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
        marketplaceUrl = base + "/internal/marketplace";
        balanceUrl = base + "/internal/balance";
        skinsSyncUrl = base + "/internal/skins/sync";
        skinsReportUrl = base + "/internal/skins/report";
        inventoryUrl = base + "/internal/inventory/report";
        inventoryDeletesUrl = base + "/internal/inventory/deletions";
        iconsUrl = base + "/internal/items/icons";

        String panel = getConfig().getString("panel-url", "");
        panelUrl = panel == null ? "" : panel.trim();

        String token = getConfig().getString("service-token", "");
        serviceToken = token == null ? "" : token.trim();

        cooldownMillis = Math.max(0, getConfig().getInt("cooldown-seconds", 3)) * 1000L;
        statsReportSeconds = Math.max(1, getConfig().getInt("stats-report-seconds", 5));
        inventoryReportSeconds = Math.max(5, getConfig().getInt("inventory-report-seconds", 60));
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

        if(command.getName().equalsIgnoreCase("services")) {
            if(!allowAttempt(player.getUniqueId())) {player.sendMessage("[Economy] Wait a few seconds and try again.");return true;}
            serviceCommand(player,args);return true;
        }
        if (command.getName().equalsIgnoreCase("quests")) {
            if (args.length>2 || (args.length>=1 && !args[0].equalsIgnoreCase("start")) || (args.length==2 && !List.of("hunting","fishing","farming").contains(args[1].toLowerCase(Locale.ROOT)))) {player.sendMessage("[Quests] Usage: /quests or /quests start [hunting|fishing|farming]");return true;}
            if (!allowAttempt(player.getUniqueId())) {player.sendMessage("[Quests] Wait a few seconds and try again.");return true;}
            queryContract(player,args.length>=1,true,args.length==2?args[1].toLowerCase(Locale.ROOT):"hunting"); return true;
        }
        if (command.getName().equalsIgnoreCase("balance")) {
            if (args.length != 0) {
                player.sendMessage("[Coins] Usage: /bal or /balance");
                return true;
            }
            showBalance(player);
            return true;
        }
        if (command.getName().equalsIgnoreCase("sell")) {
            if (!allowAttempt(player.getUniqueId())) {
                player.sendMessage("[Market] Wait a few seconds and try again.");
                return true;
            }
            sellCommand(player, args);
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
                if (flush(uuid, requestTimeout) && flushEconomy(requestTimeout)) {
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

    private void sellCommand(Player player, String[] args) {
        if (serviceToken.isBlank() || serviceToken.contains("${")) {
            player.sendMessage("[Market] Marketplace is not configured on this server.");
            return;
        }
        if (args.length < 1 || args.length > 2) {
            player.sendMessage("[Market] Usage: /sell <price> [price for stack]");
            player.sendMessage("[Market] Lists the item or stack in your main hand on the marketplace.");
            return;
        }
        long unitPrice;
        try {
            unitPrice = Long.parseLong(args[0]);
            if (unitPrice < 1 || unitPrice > 1_000_000_000L) throw new NumberFormatException();
        } catch (NumberFormatException e) {
            player.sendMessage("[Market] Price must be a positive integer between 1 and 1,000,000,000.");
            return;
        }
        ItemStack item = player.getInventory().getItemInMainHand();
        if (item.isEmpty() || item.getType() == Material.AIR) {
            player.sendMessage("[Market] Hold the item or stack you want to sell in your main hand.");
            return;
        }
        int quantity = item.getAmount();
        if (quantity < 1 || quantity > 230) {
            player.sendMessage("[Market] Invalid item quantity.");
            return;
        }
        long lotPrice;
        if (args.length == 2) {
            try {
                lotPrice = Long.parseLong(args[1]);
                if (lotPrice < 1 || lotPrice > 1_000_000_000L) throw new NumberFormatException();
            } catch (NumberFormatException e) {
                player.sendMessage("[Market] Price for stack must be a positive integer between 1 and 1,000,000,000.");
                return;
            }
        } else {
            try {
                lotPrice = Math.multiplyExact(unitPrice, (long) quantity);
                if (lotPrice < 1 || lotPrice > 1_000_000_000L) throw new ArithmeticException();
            } catch (ArithmeticException e) {
                player.sendMessage("[Market] Total lot price exceeds 1,000,000,000 coins. Specify a custom stack price.");
                return;
            }
        }
        int slot = player.getInventory().getHeldItemSlot();
        String fingerprint;
        try {
            fingerprint = InventoryNbt.fingerprint(item.serializeAsBytes());
        } catch (Exception error) {
            player.sendMessage("[Market] Cannot read this item. No listing was created.");
            return;
        }
        String itemJson = slotJson(item);
        queueIconKey(item);
        String displayName = formatItemName(item);
        UUID uuid = player.getUniqueId();

        var payload = new com.google.gson.JsonObject();
        payload.addProperty("uuid", uuid.toString());
        payload.addProperty("slot", slot);
        payload.addProperty("fingerprint", fingerprint);
        payload.addProperty("quantity", quantity);
        payload.addProperty("unit_price", unitPrice);
        payload.addProperty("lot_price", lotPrice);
        payload.add("item", com.google.gson.JsonParser.parseString(itemJson));

        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            HttpResponse<String> response = post(marketplaceUrl + "/sell", payload.toString(), requestTimeout);
            if (response == null) {
                marketMessage(uuid, "Could not reach the marketplace. Try again in a moment.");
                return;
            }
            int code = response.statusCode();
            if (code == 404) {
                marketMessage(uuid, "You must link your account to the website first. Use /website link <code>.");
                return;
            }
            if (code == 409) {
                marketMessage(uuid, "Another inventory or marketplace transfer is pending. Try again in a moment.");
                return;
            }
            if (code == 429) {
                marketMessage(uuid, "You have reached the limit of 100 active listings.");
                return;
            }
            if (code != 201 && code != 200 && code != 202) {
                marketMessage(uuid, "The marketplace rejected that listing request (" + code + ").");
                return;
            }
            String taskId = null;
            try {
                var bodyObj = com.google.gson.JsonParser.parseString(response.body()).getAsJsonObject();
                if (bodyObj.has("task_id")) taskId = bodyObj.get("task_id").getAsString();
            } catch (Exception ignored) {}

            syncMarketplace();

            final String expectedTaskId = taskId;
            getServer().getScheduler().runTask(this, () -> {
                Player p = getServer().getPlayer(uuid);
                if (p == null || !p.isOnline() || !isAuthenticated(p)) return;
                var key = new NamespacedKey(this, "marketplace");
                String receipt = p.getPersistentDataContainer().getOrDefault(key, org.bukkit.persistence.PersistentDataType.STRING, "");
                boolean conflict = false;
                if (!receipt.isEmpty()) {
                    try {
                        var obj = com.google.gson.JsonParser.parseString(receipt).getAsJsonObject();
                        if (expectedTaskId == null || expectedTaskId.equals(obj.get("id").getAsString())) {
                            String status = obj.get("status").getAsString();
                            conflict = "conflict".equals(status);
                        }
                    } catch (Exception ignored) {}
                }
                if (conflict) {
                    p.sendMessage("[Market] Listing cancelled: item in slot changed.");
                } else {
                    String msg = quantity > 1
                        ? String.format(Locale.ROOT, "Listed %s x%d for %,d coins each (lot: %,d coins).", displayName, quantity, unitPrice, lotPrice)
                        : String.format(Locale.ROOT, "Listed %s for %,d coins.", displayName, unitPrice);
                    p.sendMessage("[Market] " + msg);
                }
            });
        });
    }

    private String formatItemName(ItemStack item) {
        if (item.getItemMeta() != null && item.getItemMeta().hasDisplayName()) {
            return item.getItemMeta().getDisplayName();
        }
        String[] words = item.getType().name().toLowerCase(Locale.ROOT).split("_");
        StringBuilder sb = new StringBuilder();
        for (String word : words) {
            if (!word.isEmpty()) {
                if (sb.length() > 0) sb.append(' ');
                sb.append(Character.toUpperCase(word.charAt(0))).append(word.substring(1));
            }
        }
        return sb.toString();
    }

    private void marketMessage(UUID uuid, String text) {
        try {
            getServer().getScheduler().runTask(this, () -> {
                Player p = getServer().getPlayer(uuid);
                if (p != null && p.isOnline() && isAuthenticated(p)) {
                    p.sendMessage("[Market] " + text);
                }
            });
        } catch (Exception ignored) {}
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
            economyLogin(player);
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

    // --- Economy: independent durable outbox; never reuses statistics as money. ---
    private record EconomyKey(UUID uuid, String day, String contract) {}
    static final class EconomyCount {
        long seconds,kills,fish,crops,mined,smelted;
        long[] snapshot(){return new long[]{Math.min(86400,seconds),Math.min(10000,kills),Math.min(10000,fish),Math.min(10000,crops),Math.min(10000,mined),Math.min(10000,smelted)};}
        void subtract(long[] accepted){seconds-=accepted[0];kills-=accepted[1];fish-=accepted[2];crops-=accepted[3];mined-=accepted[4];smelted-=accepted[5];}
        boolean empty(){return seconds==0&&kills==0&&fish==0&&crops==0&&mined==0&&smelted==0;}
    }
    static final class QuestRules {
        static boolean fish(String type){return List.of("COD","SALMON","TROPICAL_FISH","PUFFERFISH").contains(type);}
        static boolean harvest(String type,int age,int max){return max>0&&age==max&&List.of("WHEAT","CARROTS","POTATOES","BEETROOTS").contains(type);}
    }
    private final Object economyLock = new Object();
    private final Object economyFlushLock = new Object();
    private final Map<EconomyKey, EconomyCount> economyCounts = new LinkedHashMap<>();
    private final Map<UUID, Long> lastActive = new ConcurrentHashMap<>();
    private final Map<UUID, Long> economySampleAt = new ConcurrentHashMap<>();
    private final Map<UUID, com.google.gson.JsonObject> contracts = new ConcurrentHashMap<>();
    private final Map<UUID, Location> lastRewardKill = new ConcurrentHashMap<>();
    private final Map<UUID, Long> lastRewardKillAt = new ConcurrentHashMap<>();
    private Path economyOutbox;
    private String economyPending;
    private Map<EconomyKey, long[]> economyPendingCounts = Map.of();
    private String economyBase;

    private void initializeEconomy() {
        economyBase = statsUrl.substring(0, statsUrl.length()-"/internal/stats/report".length()) + "/internal/economy";
        economyOutbox = getDataFolder().toPath().resolve("pending-economy.json");
        try { if (Files.exists(economyOutbox)) economyPending = Files.readString(economyOutbox); }
        catch (IOException error) { throw new IllegalStateException("Cannot recover economy outbox", error); }
        if (getCommand("quests") != null) {
            getCommand("quests").setExecutor(this);
            getCommand("quests").setTabCompleter((sender,command,alias,args) -> {
                if (!(sender instanceof Player player) || !isAuthenticated(player)) return List.of();
                if(args.length==2 && args[0].equalsIgnoreCase("start"))return List.of("hunting","fishing","farming").stream().filter(v->v.startsWith(args[1].toLowerCase(Locale.ROOT))).toList();
                if(args.length!=1)return List.of();
                return "start".startsWith(args[0].toLowerCase(Locale.ROOT)) ? List.of("start") : List.of();
            });
        }
        getServer().getScheduler().runTaskTimer(this, this::sampleEconomy, 200L, 200L);
        getServer().getScheduler().runTaskTimerAsynchronously(this, () -> flushEconomy(requestTimeout), 100L, 100L);
        for (Player player : getServer().getOnlinePlayers()) if (isAuthenticated(player)) economyLogin(player);
    }
    private String economyDay() { return java.time.LocalDate.now(java.time.ZoneOffset.UTC).toString(); }
    private void economyLogin(Player player) {
        if (!isAuthenticated(player)) return;
        countersFor(player); // Remember a server-observed name even without activity.
        economySampleAt.put(player.getUniqueId(),System.currentTimeMillis());
        synchronized (economyLock) {
            economyCounts.computeIfAbsent(new EconomyKey(player.getUniqueId(),economyDay(),""), k -> new EconomyCount());
        }
        queryContract(player,false,false);
    }
    private void sampleEconomy() {
        // A ten-second sample is credited only following recent physical activity.
        // Lag never creates extra time, and ticks on UTC midnight belong to the
        // preceding interval, avoiding a fabricated activity day from a boundary.
        String day = java.time.Instant.now().minusSeconds(10).atZone(java.time.ZoneOffset.UTC).toLocalDate().toString();
        long now=System.currentTimeMillis();
        synchronized (economyLock) {
            for (Player player : getServer().getOnlinePlayers()) {
                if (!isAuthenticated(player) || player.getGameMode()!=org.bukkit.GameMode.SURVIVAL) continue;
                long previous=economySampleAt.getOrDefault(player.getUniqueId(),now);
                economySampleAt.put(player.getUniqueId(),now);
                long seconds=Math.max(0,Math.min(10,(now-previous)/1000));
                if (seconds==0 || now-lastActive.getOrDefault(player.getUniqueId(),0L)>60_000L) continue;
                names.put(player.getUniqueId(),player.getName());
                EconomyCount count=economyCounts.computeIfAbsent(new EconomyKey(player.getUniqueId(),day,""), k -> new EconomyCount());
                count.seconds+=seconds;
            }
        }
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void onEconomySpawn(org.bukkit.event.entity.CreatureSpawnEvent event) {
        if (event.getSpawnReason()==org.bukkit.event.entity.CreatureSpawnEvent.SpawnReason.NATURAL
            && event.getEntity() instanceof org.bukkit.entity.Monster) {
            event.getEntity().getPersistentDataContainer().set(new NamespacedKey(this,"quest_natural"),org.bukkit.persistence.PersistentDataType.BYTE,(byte)1);
        }
    }
    private void economyKill(EntityDeathEvent event, Player killer) {
        if (killer.getGameMode()!=org.bukkit.GameMode.SURVIVAL || !(event.getEntity() instanceof org.bukkit.entity.Monster)
            || !event.getEntity().getPersistentDataContainer().has(new NamespacedKey(this,"quest_natural"),org.bukkit.persistence.PersistentDataType.BYTE)) return;
        UUID uuid=killer.getUniqueId(); long now=System.currentTimeMillis();
        if (now-lastActive.getOrDefault(uuid,0L)>60_000L || now-lastRewardKillAt.getOrDefault(uuid,0L)<2000L) return;
        Location location=event.getEntity().getLocation(); Location previous=lastRewardKill.get(uuid);
        if (previous!=null && previous.getWorld().equals(location.getWorld()) && previous.distanceSquared(location)<64) return;
        var contract=contracts.get(uuid);
        if (!questAccepts(killer,"hunting")) return;
        lastRewardKill.put(uuid,location); lastRewardKillAt.put(uuid,now);
        synchronized (economyLock) {
            economyCounts.computeIfAbsent(new EconomyKey(uuid,economyDay(),contract.get("id").getAsString()),k -> new EconomyCount()).kills++;
        }
    }
    private boolean questAccepts(Player player,String kind) {
        if(!isAuthenticated(player)||player.getGameMode()!=org.bukkit.GameMode.SURVIVAL)return false;
        var contract=contracts.get(player.getUniqueId());
        return contract!=null && contract.get("status").getAsString().equals("active")
            && System.currentTimeMillis()/1000<contract.get("expires").getAsLong()
            && (contract.has("kind")?contract.get("kind").getAsString():"hunting").equals(kind);
    }
    private void questProgress(Player player,String kind,int counter,int amount) {
        if(amount<=0||!questAccepts(player,kind))return;
        UUID uuid=player.getUniqueId();var contract=contracts.get(uuid);
        synchronized(economyLock) {
            var count=economyCounts.computeIfAbsent(new EconomyKey(uuid,economyDay(),contract.get("id").getAsString()),k->new EconomyCount());
            switch(counter) {case 2 -> count.fish+=amount;case 3 -> count.crops+=amount;case 4 -> count.mined+=amount;case 5 -> count.smelted+=amount;default -> throw new IllegalArgumentException("Unknown objective");}
        }
    }
    private boolean ironOre(org.bukkit.block.Block block) {
        return block.getType()==org.bukkit.Material.IRON_ORE||block.getType()==org.bukkit.Material.DEEPSLATE_IRON_ORE;
    }
    private long orePosition(org.bukkit.block.Block block) {return ((long)block.getY()<<8)|((block.getZ()&15)<<4)|(block.getX()&15);}
    private boolean placedOre(org.bukkit.block.Block block,boolean add,boolean remove) {
        var key=new NamespacedKey(this,"quest_placed_iron");var data=block.getChunk().getPersistentDataContainer();
        long[] saved=data.getOrDefault(key,org.bukkit.persistence.PersistentDataType.LONG_ARRAY,new long[0]);
        var positions=new java.util.HashSet<Long>();for(long position:saved)positions.add(position);
        boolean exists=positions.contains(orePosition(block));
        if(add)positions.add(orePosition(block));if(remove)positions.remove(orePosition(block));
        if(add||remove) {if(positions.isEmpty())data.remove(key);else data.set(key,org.bukkit.persistence.PersistentDataType.LONG_ARRAY,positions.stream().mapToLong(Long::longValue).toArray());}
        return exists;
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void onQuestOrePlace(BlockPlaceEvent event) {if(ironOre(event.getBlockPlaced()))placedOre(event.getBlockPlaced(),true,false);}
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void onQuestPiston(org.bukkit.event.block.BlockPistonExtendEvent event) {
        for(var block:event.getBlocks())if(ironOre(block))placedOre(block.getRelative(event.getDirection()),true,false);
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void onQuestPistonRetract(org.bukkit.event.block.BlockPistonRetractEvent event) {
        for(var block:event.getBlocks())if(ironOre(block))placedOre(block.getRelative(event.getDirection()),true,false);
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void onQuestHarvest(BlockBreakEvent event) {
        Player player=event.getPlayer();var block=event.getBlock();
        boolean placed=ironOre(block)&&placedOre(block,false,true);
        if(!isAuthenticated(player)||player.getGameMode()!=org.bukkit.GameMode.SURVIVAL||!event.isDropItems())return;
        if(ironOre(block)&&!placed&&block.getDrops(player.getInventory().getItemInMainHand(),player).stream().anyMatch(item->item.getType()==org.bukkit.Material.RAW_IRON))questProgress(player,"starter_iron",4,1);
        if(block.getBlockData() instanceof org.bukkit.block.data.Ageable crop&&QuestRules.harvest(block.getType().name(),crop.getAge(),crop.getMaximumAge()))questProgress(player,"farming",3,1);
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void onQuestFish(PlayerFishEvent event) {
        if(event.getState()!=PlayerFishEvent.State.CAUGHT_FISH||!(event.getCaught() instanceof org.bukkit.entity.Item caught))return;
        if(!QuestRules.fish(caught.getItemStack().getType().name()))return;
        if(isAuthenticated(event.getPlayer()))lastActive.put(event.getPlayer().getUniqueId(),System.currentTimeMillis());
        questProgress(event.getPlayer(),"fishing",2,1);
    }
    @EventHandler(priority=EventPriority.MONITOR)
    public void onQuestSmelt(org.bukkit.event.inventory.FurnaceExtractEvent event) {
        if(event.getItemType()!=org.bukkit.Material.IRON_INGOT)return;
        if(isAuthenticated(event.getPlayer()))lastActive.put(event.getPlayer().getUniqueId(),System.currentTimeMillis());
        questProgress(event.getPlayer(),"starter_iron",5,event.getItemAmount());
    }
    private boolean flushEconomy(Duration timeout) {
        synchronized (economyFlushLock) {
            if (economyPending!=null && !sendEconomyPending(timeout)) return false;
            // One immutable player batch at a time. Batches include zero activity
            // after authentication, so an idle newcomer still receives their grant.
            while (true) {
                com.google.gson.JsonObject body=new com.google.gson.JsonObject();
                Map<EconomyKey,long[]> snapshot=new LinkedHashMap<>();
                synchronized (economyLock) {
                    if (economyCounts.isEmpty()) return true;
                    UUID uuid=economyCounts.keySet().iterator().next().uuid();
                    String username=names.get(uuid); if (username==null) return false;
                    body.addProperty("id",UUID.randomUUID().toString()); body.addProperty("uuid",uuid.toString()); body.addProperty("username",username);
                    var days=new com.google.gson.JsonArray();
                    for (var entry:economyCounts.entrySet()) {
                        if (!entry.getKey().uuid().equals(uuid) || snapshot.size()>=1000) continue;
                        var key=entry.getKey(); var count=entry.getValue();
                        long[] captured=count.snapshot();
                        long seconds=captured[0],kills=captured[1],fish=captured[2],crops=captured[3],mined=captured[4],smelted=captured[5];
                        var day=new com.google.gson.JsonObject(); day.addProperty("day",key.day()); day.addProperty("active_seconds",seconds); day.addProperty("kills",kills);
                        if (!key.contract().isEmpty()) day.addProperty("contract_id",key.contract());
                        day.addProperty("fish_caught",fish);day.addProperty("crops_harvested",crops);day.addProperty("iron_mined",mined);day.addProperty("iron_smelted",smelted);
                        days.add(day); snapshot.put(key,captured);
                    }
                    body.add("days",days);
                }
                try {
                    Path temporary=economyOutbox.resolveSibling("pending-economy.tmp");
                    Files.writeString(temporary,body.toString());
                    Files.move(temporary,economyOutbox,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
                    economyPending=body.toString(); economyPendingCounts=snapshot;
                } catch(IOException error) {getLogger().warning("Cannot persist economy report: "+error);return false;}
                if (!sendEconomyPending(timeout)) return false;
            }
        }
    }
    private boolean sendEconomyPending(Duration timeout) {
        var response=post(economyBase+"/report",economyPending,timeout);
        if (response==null || response.statusCode()!=200) return false;
        try {Files.deleteIfExists(economyOutbox);} catch(IOException error) {return false;}
        synchronized(economyLock) {
            for(var entry:economyPendingCounts.entrySet()) {
                var count=economyCounts.get(entry.getKey()); if(count==null) continue;
                count.subtract(entry.getValue());
                if(count.empty()) economyCounts.remove(entry.getKey());
            }
        }
        economyPending=null; economyPendingCounts=Map.of(); return true;
    }
    private void queryContract(Player player, boolean start, boolean announceResult) {queryContract(player,start,announceResult,"hunting");}
    private void queryContract(Player player, boolean start, boolean announceResult,String kind) {
        UUID uuid=player.getUniqueId(); String username=player.getName();
        getServer().getScheduler().runTaskAsynchronously(this,() -> {
            String message;
            if (!flushEconomy(requestTimeout)) message="[Quests] Cannot sync activity. Try /quests again.";
            else {
                var body=new com.google.gson.JsonObject(); body.addProperty("uuid",uuid.toString()); body.addProperty("username",username);body.addProperty("start",start);body.addProperty("kind",kind);
                var response=post(economyBase+"/contract",body.toString(),requestTimeout);
                if(response==null) message="[Quests] The panel is unavailable. Try again.";
                else if(response.statusCode()==429) message="[Quests] Daily limit reached: four contracts per UTC day.";
                else if(response.statusCode()==402) message="[Quests] No funded coin reward is available. Coin shares renew at UTC midnight after observed activity; your existing coins are unchanged.";
                else if(response.statusCode()!=200) message="[Quests] Cannot load your contract. Try again.";
                else {
                    try {
                        var json=com.google.gson.JsonParser.parseString(response.body());
                        if(json.isJsonNull()) {contracts.remove(uuid);message="[Quests] Use /quests start to begin the iron starter quest, then /quests start hunting, fishing or farming.";}
                        else {
                            var contract=json.getAsJsonObject(); contracts.put(uuid,contract);
                            String objective=contract.has("kind")?contract.get("kind").getAsString():"hunting";
                            int progress=contract.get("progress").getAsInt(),target=contract.get("target").getAsInt();
                            String goal=switch(objective) {
                                case "starter_iron" -> "Mine iron ore: "+progress+"/"+target+"; smelt/extract iron ingots: "+contract.get("secondary_progress").getAsInt()+"/"+target;
                                case "fishing" -> "Catch fish with a rod: "+progress+"/"+target;
                                case "farming" -> "Harvest mature wheat, carrots, potatoes or beetroot: "+progress+"/"+target;
                                default -> "Natural hostile mobs: "+progress+"/"+target;
                            };
                            String legacy="";
                            if(contract.has("iron") && (contract.get("iron").getAsInt()>0||contract.get("bread").getAsInt()>0||contract.get("xp").getAsInt()>0))legacy="; existing promised items: "+contract.get("iron")+" iron, "+contract.get("bread")+" bread, "+contract.get("xp")+" XP";
                            message="[Quests] "+(contract.get("status").getAsString().equals("paid")?"completed":contract.get("status").getAsString())+": "+goal+". Reward: "+contract.get("reward").getAsLong()+" coins"+legacy+". "+(objective.equals("starter_iron")?"Complete both objectives to unlock repeatable quests. No free iron or bonus XP. ":"")+"Four contracts per UTC day; 24-hour expiry. Use /quests start [hunting|fishing|farming].";
                        }
                    }catch(Exception error) {message="[Quests] Could not read the contract. Try again.";}
                }
            }
            if(announceResult) {
                String result=message;
                try {getServer().getScheduler().runTask(this,() -> {if(player.isOnline() && isAuthenticated(player))player.sendMessage(result);});}catch(Exception ignored){}
            }
        });
    }

    private final Map<UUID, com.google.gson.JsonObject> repairQuotes = new ConcurrentHashMap<>();
    private final Map<UUID, String> pendingRepairs = new ConcurrentHashMap<>();
    private final java.util.concurrent.atomic.AtomicBoolean economyTasksRunning = new java.util.concurrent.atomic.AtomicBoolean();
    private Path repairDirectory;

    private void initializeEconomyServices() {
        repairDirectory = getDataFolder().toPath().resolve("pending-repairs");
        try {
            Files.createDirectories(repairDirectory);
            try (var files=Files.list(repairDirectory)) {
                for (Path file:files.filter(p -> p.getFileName().toString().endsWith(".json")).toList()) {
                    var body=com.google.gson.JsonParser.parseString(Files.readString(file)).getAsJsonObject();
                    UUID uuid=UUID.fromString(body.get("uuid").getAsString());
                    if(!file.getFileName().toString().equals(uuid+".json")) throw new IOException("Invalid repair receipt path");
                    pendingRepairs.put(uuid,body.toString());
                }
            }
        } catch(Exception error) {throw new IllegalStateException("Cannot recover repair requests",error);}
        if(getCommand("services")!=null) {
            getCommand("services").setExecutor(this);
            getCommand("services").setTabCompleter((sender,command,alias,args) -> {
                if(!(sender instanceof Player p)||!isAuthenticated(p))return List.of();
                if(args.length==1)return List.of("repair","travel").stream().filter(v->v.startsWith(args[0].toLowerCase(Locale.ROOT))).toList();
                if(args.length==2 && args[0].equalsIgnoreCase("repair") && "confirm".startsWith(args[1].toLowerCase(Locale.ROOT)))return List.of("confirm");
                return List.of();
            });
        }
        getServer().getScheduler().runTaskTimerAsynchronously(this,this::syncEconomyServices,100L,100L);
    }
    private void economyMessage(UUID uuid,String text) {
        try {getServer().getScheduler().runTask(this,()->{
            Player p=getServer().getPlayer(uuid);
            if(p!=null&&p.isOnline()&&isAuthenticated(p))p.sendMessage("[Economy] "+text);
        });}catch(Exception ignored){}
    }
    private void serviceCommand(Player player,String[] args) {
        if(args.length==0) {player.sendMessage("[Economy] /services repair shows a quote for the held iron item. Repairs cost 10 coins per quarter durability, at most three units per UTC day; keep 1,000 coins. Private-block travel is not available yet.");return;}
        if(args.length==1 && args[0].equalsIgnoreCase("travel")) {player.sendMessage("[Economy] Private-block travel will be available when private blocks are added. No coins were charged.");return;}
        if(!args[0].equalsIgnoreCase("repair")||args.length>2||(args.length==2&&!args[1].equalsIgnoreCase("confirm"))) {player.sendMessage("[Economy] Usage: /services repair [confirm] or /services travel");return;}
        UUID uuid=player.getUniqueId();
        if(pendingRepairs.containsKey(uuid)) {player.sendMessage("[Economy] A saved repair request is awaiting confirmation from the panel. It will retry automatically.");return;}
        if(args.length==2) {
            var body=repairQuotes.remove(uuid);
            if(body==null || body.get("quote_expires").getAsLong()<System.currentTimeMillis()/1000) {player.sendMessage("[Economy] Quote expired. Use /services repair again.");return;}
            try {
                Path file=repairDirectory.resolve(uuid+".json"),temporary=repairDirectory.resolve(uuid+".tmp");
                Files.writeString(temporary,body.toString());Files.move(temporary,file,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
                pendingRepairs.put(uuid,body.toString());
                player.sendMessage("[Economy] Repair requested for "+body.get("expected_price").getAsLong()+" coins. Keep the item in its slot; a changed item will be refunded.");
            }catch(IOException error) {player.sendMessage("[Economy] Cannot save your repair request. No request was sent.");}
            return;
        }
        ItemStack item=player.getInventory().getItemInMainHand();
        if(item.isEmpty()||item.getAmount()!=1||!item.getType().name().startsWith("IRON_")||!(item.getItemMeta() instanceof org.bukkit.inventory.meta.Damageable damage)||damage.getDamage()<=0) {player.sendMessage("[Economy] Hold a damaged iron tool, weapon or armor item.");return;}
        int max=damage.hasMaxDamage()?damage.getMaxDamage():item.getType().getMaxDurability();
        var body=new com.google.gson.JsonObject();body.addProperty("uuid",uuid.toString());body.addProperty("username",player.getName());body.addProperty("id",UUID.randomUUID().toString());body.addProperty("slot",player.getInventory().getHeldItemSlot());
        try {body.addProperty("fingerprint",InventoryNbt.fingerprint(item.serializeAsBytes()));}
        catch(Exception error){player.sendMessage("[Economy] Cannot read this item. No repair request was sent.");return;}
        body.addProperty("key",item.getType().getKey().toString());body.addProperty("damage",damage.getDamage());body.addProperty("max_damage",max);
        getServer().getScheduler().runTaskAsynchronously(this,()->{
            var response=post(economyBase+"/repair/quote",body.toString(),requestTimeout);
            if(response==null||response.statusCode()!=200) {economyMessage(uuid,response!=null&&response.statusCode()==429?"All three repair units are used today.":"Cannot quote this repair. No coins were charged.");return;}
            try {
                var quote=com.google.gson.JsonParser.parseString(response.body()).getAsJsonObject();
                body.addProperty("expected_price",quote.get("price").getAsLong());body.addProperty("expected_units",quote.get("units").getAsInt());body.addProperty("quote_expires",quote.get("quote_expires").getAsLong());
                repairQuotes.put(uuid,body);
                economyMessage(uuid,"Repair quote: "+quote.get("price").getAsLong()+" coins for "+quote.get("units").getAsInt()+" quarter-durability units. Keep at least 1,000 coins after payment. Use /services repair confirm within 60 seconds.");
            }catch(Exception error){economyMessage(uuid,"Cannot read the repair quote. No coins were charged.");}
        });
    }
    private void syncEconomyServices() {
        if(!economyTasksRunning.compareAndSet(false,true))return;
        try {
            int sent=0;
            for(var entry:pendingRepairs.entrySet()) {
                if(sent++>=25)break;
                var response=post(economyBase+"/repair",entry.getValue(),requestTimeout);
                if(response==null||response.statusCode()>=500)break;
                int code=response.statusCode();
                String message;
                if(code==200) {
                    String status=com.google.gson.JsonParser.parseString(response.body()).getAsJsonObject().get("status").getAsString();
                    message=switch(status) {
                        case "done" -> "This repair was already delivered. Your request was recovered without another charge.";
                        case "conflict" -> "This repair was refunded because the item changed. Your request was recovered without another charge.";
                        case "pending" -> "Repair is queued. Keep the original item in its slot until delivery.";
                        default -> throw new IOException("Unknown repair receipt status");
                    };
                }
                else if(code==402)message="Repair was not purchased: it must leave 1,000 coins in your wallet.";
                else if(code==412)message="Repair quote changed or expired. Use /services repair for a new quote.";
                else if(code==409)message="A repair is already pending, or this request conflicts. Check the original request.";
                else if(code==429)message="All three repair units are used today.";
                else message="Repair request rejected. Use /services repair again.";
                // Remove only after a definitive result. A lost response retains
                // the exact immutable ID, fields and quote for receipt recovery.
                Files.deleteIfExists(repairDirectory.resolve(entry.getKey()+".json"));
                pendingRepairs.remove(entry.getKey(),entry.getValue());economyMessage(entry.getKey(),message);
            }
            var response=post(economyBase+"/tasks/sync","{}",requestTimeout);
            if(response==null||response.statusCode()!=200||response.body().length()>1_000_000)return;
            for(var element:com.google.gson.JsonParser.parseString(response.body()).getAsJsonArray()) {
                String report=getServer().getScheduler().callSyncMethod(this,()->applyEconomyTask(element.getAsJsonObject())).get();
                if(report!=null) {
                    var accepted=post(economyBase+"/tasks/report",report,requestTimeout);
                    if(accepted==null||accepted.statusCode()!=200)break;
                }
            }
        }catch(Exception error){getLogger().warning("Economy delivery deferred: "+error.getClass().getSimpleName());}
        finally{economyTasksRunning.set(false);}
    }
    private String applyEconomyTask(com.google.gson.JsonObject task)throws Exception {
        UUID uuid=UUID.fromString(task.get("uuid").getAsString());
        String id=UUID.fromString(task.get("id").getAsString()).toString();
        Player player=getServer().getPlayer(uuid);
        if(player==null||!player.isOnline()||!isAuthenticated(player))return null;
        var key=new NamespacedKey(this,"economy_task");
        String saved=player.getPersistentDataContainer().getOrDefault(key,org.bukkit.persistence.PersistentDataType.STRING,"");
        com.google.gson.JsonObject result;
        boolean fresh=saved.isEmpty()||!com.google.gson.JsonParser.parseString(saved).getAsJsonObject().get("id").getAsString().equals(id);
        if(!fresh) result=com.google.gson.JsonParser.parseString(saved).getAsJsonObject();
        else {
            result=new com.google.gson.JsonObject();result.addProperty("id",id);result.addProperty("uuid",uuid.toString());result.addProperty("status","done");
            String kind=task.get("kind").getAsString();
            if(kind.equals("reward")) {
                int iron=task.get("iron").getAsInt(),bread=task.get("bread").getAsInt(),xp=task.get("xp").getAsInt();
                if(iron<0||iron>8||bread<0||bread>16||xp<0||xp>5)throw new IOException("Invalid economy reward");
                var empty=new ArrayList<Integer>();
                for(int i=0;i<36;i++){ItemStack existing=player.getInventory().getItem(i);if(existing==null||existing.isEmpty())empty.add(i);}
                if(empty.size()<(iron>0?1:0)+(bread>0?1:0))return null;
                int index=0;
                if(iron>0)player.getInventory().setItem(empty.get(index++),new ItemStack(org.bukkit.Material.IRON_INGOT,iron));
                if(bread>0)player.getInventory().setItem(empty.get(index),new ItemStack(org.bukkit.Material.BREAD,bread));
                if(xp>0)player.giveExp(xp);
            } else if(kind.equals("repair")) {
                int slot=task.get("slot").getAsInt(),before=task.get("damage").getAsInt(),max=task.get("max_damage").getAsInt(),units=task.get("units").getAsInt();
                if(slot<0||slot>40||max<1||max>10000||units<1||units>3)throw new IOException("Invalid repair task");
                ItemStack current=player.getInventory().getItem(slot);
                boolean matches=current!=null&&!current.isEmpty()&&current.getAmount()==1
                    &&current.getType().getKey().toString().equals(task.get("key").getAsString())
                    &&InventoryNbt.fingerprint(current.serializeAsBytes()).equals(task.get("fingerprint").getAsString());
                if(matches && current.getItemMeta() instanceof org.bukkit.inventory.meta.Damageable damage
                    &&damage.getDamage()==before && (damage.hasMaxDamage()?damage.getMaxDamage():current.getType().getMaxDurability())==max) {
                    ItemStack repaired=current.clone();var meta=(org.bukkit.inventory.meta.Damageable)repaired.getItemMeta();
                    meta.setDamage(Math.max(0,before-units*((max+3)/4)));repaired.setItemMeta(meta);player.getInventory().setItem(slot,repaired);
                }else result.addProperty("status","conflict");
            }else throw new IOException("Unknown economy task");
            player.getPersistentDataContainer().set(key,org.bukkit.persistence.PersistentDataType.STRING,result.toString());
        }
        player.saveData();
        Path file=getServer().getLevelDirectory().resolve("players/data").resolve(uuid+".dat");
        if(!result.toString().equals(InventoryNbt.read(Files.readAllBytes(file)).economyReceipt()))throw new IOException("Economy receipt not saved");
        inventoryPending.remove(uuid);inventoryAccepted.remove(uuid);inventoryAcceptedAt.remove(uuid);
        if(fresh)player.sendMessage(result.get("status").getAsString().equals("done")?"[Economy] Your quest rewards or repair were delivered.":"[Economy] The repair item changed. Your payment will be refunded.");
        return result.toString();
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
        lastActive.put(player.getUniqueId(),System.currentTimeMillis());
        countersFor(player).blocksPlaced.incrementAndGet();
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onBlockBroken(BlockBreakEvent event) {
        Player player = event.getPlayer();
        // MONITOR is the last word on the event, so the cancellation decision is final.
        if (!isAuthenticated(player) || event.isCancelled()) {
            return;
        }
        lastActive.put(player.getUniqueId(),System.currentTimeMillis());
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
        lastActive.put(player.getUniqueId(),System.currentTimeMillis());
        countersFor(player).distanceCm.addAndGet(Math.round(blocks * 100.0));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onEntityDeath(EntityDeathEvent event) {
        Player killer = event.getEntity().getKiller();
        if (killer != null && isAuthenticated(killer)) {
            countersFor(killer).mobsKilled.incrementAndGet();
            economyKill(event,killer);
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
        repairQuotes.remove(uuid);
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

    // --- Measuring and reporting inventories ---------------------------------

    /**
     * Samples the live inventories of authenticated players on the server
     * thread (Bukkit inventories may only be read there) and queues anything
     * new for the asynchronous sender.
     *
     * <p>A snapshot is current state, not a delta: the panel keeps only the
     * newest one. A changed inventory is queued at once, and the same snapshot
     * is re-sent once a while even without changes, so the panel's "last seen"
     * stays honest and a lost send repairs itself.
     */
    private void snapshotInventories() {
        long now = System.currentTimeMillis();
        for (Player player : getServer().getOnlinePlayers()) {
            if (!isAuthenticated(player)) {
                continue;
            }
            UUID uuid = player.getUniqueId();
            try {
                String snapshot = inventorySnapshot(player);
                Long acceptedAt = inventoryAcceptedAt.get(uuid);
                boolean changed = !snapshot.equals(inventoryAccepted.get(uuid));
                boolean stale = acceptedAt == null || now - acceptedAt >= inventoryReportSeconds * 1000L;
                if (changed || stale) {
                    inventoryPending.put(uuid, snapshot);
                }
                queueIconKeys(player.getInventory());
            } catch (Exception error) {
                getLogger().warning("Could not read an inventory snapshot: " + error.getClass().getSimpleName());
            }
        }
    }

    /** Reads the 41-slot player layout: hotbar, main, armor, off hand. */
    private String inventorySnapshot(Player player) {
        PlayerInventory inventory = player.getInventory();
        StringBuilder body = new StringBuilder("{\"uuid\":\"").append(player.getUniqueId())
            .append("\",\"username\":\"").append(jsonEscape(player.getName()))
            .append("\",\"slots\":[");
        int index = 0;
        for (ItemStack item : inventory.getStorageContents()) {
            if (index++ > 0) body.append(',');
            body.append(slotJson(item));
        }
        for (ItemStack item : inventory.getArmorContents()) {
            if (index++ > 0) body.append(',');
            body.append(slotJson(item));
        }
        if (index++ > 0) body.append(',');
        body.append(slotJson(inventory.getItemInOffHand()));
        body.append("]}");
        return body.toString();
    }

    private String slotJson(ItemStack item) {
        if (item == null || item.getType() == Material.AIR) {
            return "null";
        }
        String fingerprint;
        try { fingerprint = InventoryNbt.fingerprint(item.serializeAsBytes()); }
        catch (Exception error) { throw new IllegalStateException("Cannot fingerprint inventory item", error); }
        StringBuilder slot = new StringBuilder("{\"fingerprint\":\"").append(fingerprint).append("\",\"key\":\"")
            .append(jsonEscape(item.getType().key().asString()))
            .append("\",\"amount\":").append(item.getAmount());
        if (item instanceof Damageable damageable) {
            slot.append(",\"damage\":").append(damageable.getDamage())
                .append(",\"max_damage\":").append(damageable.getMaxDamage());
        } else {
            slot.append(",\"damage\":null,\"max_damage\":null");
        }
        String display = null;
        try {
            var displayComponent = item.displayName();
            display = displayComponent == null
                ? null
                : net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer.plainText().serialize(displayComponent);
        } catch (Exception error) {
            display = null;
        }
        if (display != null) {
            display = display.length() > 128 ? display.substring(0, 128) : display;
        }
        slot.append(",\"display_name\":").append(display == null ? "null" : "\"" + jsonEscape(display) + "\"");
        slot.append(",\"enchantments\":{");
        int enchantIndex = 0;
        for (Map.Entry<Enchantment, Integer> entry : item.getEnchantments().entrySet()) {
            NamespacedKey key = entry.getKey().getKey();
            if (key == null) {
                continue;
            }
            if (enchantIndex++ > 0) slot.append(',');
            slot.append('"').append(jsonEscape(key.asString())).append("\":").append(entry.getValue());
        }
        slot.append("}}");
        return slot.toString();
    }

    /** Every item key whose texture the panel has not accepted yet. */
    private void queueIconKeys(PlayerInventory inventory) {
        for (ItemStack item : inventory.getStorageContents()) {
            queueIconKey(item);
        }
        for (ItemStack item : inventory.getArmorContents()) {
            queueIconKey(item);
        }
        queueIconKey(inventory.getItemInOffHand());
    }

    private void queueIconKey(ItemStack item) {
        if (item == null || item.getType() == Material.AIR) {
            return;
        }
        String key = item.getType().key().asString();
        if (!iconsAccepted.contains(key)) {
            iconsQueued.add(key);
        }
    }

    /**
     * Sends queued item textures and inventory snapshots. Runs off-thread and
     * never overlaps itself, because the scheduler re-arms it after it
     * returns. One pass handles a bounded number of each, so a busy server or
     * a slow panel keeps the pass short instead of starving the main loop.
     */
    private void flushInventories() {
        if (!inventoryFlushRunning.compareAndSet(false, true)) return;
        try {
            syncInventoryDeletions();
            syncMarketplace();
            sendInventories();
        } finally { inventoryFlushRunning.set(false); }
    }

    /** HTTP stays off-thread; live and offline changes run on the server thread,
     * so login/logout and disk changes cannot overlap one another. */
    private void syncInventoryDeletions() {
        try {
            var response = post(inventoryDeletesUrl, "{}", requestTimeout);
            if(response == null || response.statusCode() != 200 || response.body().length() > 65536) return;
            for(var element : com.google.gson.JsonParser.parseString(response.body()).getAsJsonArray()) {
                try {
                var task = element.getAsJsonObject();
                var result = getServer().getScheduler().callSyncMethod(this, () -> applyInventoryDeletion(task)).get();
                if(result != null) {
                    boolean refresh = task.get("request_id").isJsonNull();
                    var accepted = post(refresh ? inventoryUrl : inventoryDeletesUrl + "/report", result, requestTimeout);
                    if(accepted == null || accepted.statusCode() != 200) break;
                }
                } catch(Exception error) {
                    // One unsupported player file must not block the rest of the batch.
                    getLogger().warning("Could not process an inventory task: " + error.getClass().getSimpleName());
                }
            }
        } catch(Exception error) {
            getLogger().warning("Inventory deletion synchronization unavailable: " + error.getClass().getSimpleName());
        }
    }

    private String applyInventoryDeletion(com.google.gson.JsonObject task) throws Exception {
        UUID uuid = UUID.fromString(task.get("uuid").getAsString());
        boolean refresh = task.get("request_id").isJsonNull();
        String id = refresh ? "" : task.get("request_id").getAsString();
        int index = refresh ? -1 : task.get("slot").getAsInt();
        String expected = refresh ? "" : task.get("fingerprint").getAsString();
        if(!refresh && (index < 0 || index > 40 || !id.matches("[0-9a-f]{64}"))) throw new IOException("Invalid deletion task");
        Player player = getServer().getPlayer(uuid);
        boolean deleted;
        String snapshot;
        if(player != null) {
            if(!player.isOnline() || !isAuthenticated(player)) return null;
            var key = new NamespacedKey(this,"inventory_delete");
            var data = player.getPersistentDataContainer();
            String receipt = data.get(key,org.bukkit.persistence.PersistentDataType.STRING);
            boolean replay = (id + ":deleted").equals(receipt) || (id + ":conflict").equals(receipt);
            deleted = !refresh && (id + ":deleted").equals(receipt);
            if(!refresh && !replay) {
                ItemStack current = player.getInventory().getItem(index);
                deleted = current != null && !current.isEmpty()
                    && expected.equals(InventoryNbt.fingerprint(current.serializeAsBytes()));
                if(deleted) player.getInventory().setItem(index,null);
                data.set(key,org.bukkit.persistence.PersistentDataType.STRING,id + (deleted ? ":deleted" : ":conflict"));
            }
            // Item and receipt are saved together. A retry after a lost response
            // sees the receipt and never removes a replacement stack.
            if(!refresh) {
                player.saveData();
                // saveData logs some disk failures instead of throwing them.
                // Verify the receipt on disk before telling the panel it saved.
                Path saved = getServer().getLevelDirectory()
                    .resolve("players/data").resolve(uuid + ".dat");
                if(!(id + (deleted ? ":deleted" : ":conflict")).equals(InventoryNbt.read(Files.readAllBytes(saved)).receipt())) throw new IOException("Inventory was not saved");
            }
            snapshot = inventorySnapshot(player);
        } else {
            Path file = getServer().getLevelDirectory()
                .resolve("players/data").resolve(uuid + ".dat");
            if(!Files.isRegularFile(file)) return null;
            var nbt = InventoryNbt.read(Files.readAllBytes(file));
            // Decode the complete snapshot before writing, so unknown item
            // formats fail closed without changing the player file.
            var items = new java.util.TreeMap<Integer,ItemStack>();
            for(var entry:nbt.slots().entrySet()) {
                items.put(entry.getKey(),ItemStack.deserializeBytes(nbt.itemBytes(entry.getValue())));
            }
            boolean replay = (id + ":deleted").equals(nbt.receipt()) || (id + ":conflict").equals(nbt.receipt());
            deleted = !refresh && nbt.delete(index,expected,id);
            if(!refresh && !replay) nbt.save(file);
            if(deleted && !replay) items.remove(index);
            String[] slots = new String[41];
            java.util.Arrays.fill(slots,"null");
            for(var entry:items.entrySet()) slots[entry.getKey()] = slotJson(entry.getValue());
            snapshot = "{\"slots\":[" + String.join(",",slots) + "]}";
        }
        // Discard an older queued sample before acknowledging this operation.
        // The sender and deletion synchronizer share one serial HTTP pass.
        inventoryPending.remove(uuid);
        inventoryAccepted.remove(uuid);
        inventoryAcceptedAt.remove(uuid);
        var result = com.google.gson.JsonParser.parseString(snapshot).getAsJsonObject();
        result.addProperty("uuid",uuid.toString()); result.addProperty("request_id",id);
        result.addProperty("username",task.get("username").getAsString());
        result.addProperty("status",deleted ? "deleted" : "conflict");
        return result.toString();
    }

    /** Escrow and delivery use a saved receipt containing the withdrawn item.
     * A lost HTTP acknowledgement therefore cannot remove or deliver it twice. */
    private void syncMarketplace() {
        try {
            var response = post(marketplaceUrl + "/sync", "{}", requestTimeout);
            if(response == null || response.statusCode()!=200 || response.body().length()>40_000_000) return;
            for(var element:com.google.gson.JsonParser.parseString(response.body()).getAsJsonArray()) {
                try {
                    var result = getServer().getScheduler().callSyncMethod(this, () -> applyMarketTask(element.getAsJsonObject())).get();
                    if(result != null) {
                        var accepted = post(marketplaceUrl + "/report", result, requestTimeout);
                        if(accepted == null || accepted.statusCode()!=200) break;
                    }
                } catch(Exception error) {
                    getLogger().warning("Marketplace synchronization deferred: " + error.getClass().getSimpleName());
                }
            }
        } catch(Exception error) {
            getLogger().warning("Marketplace unavailable: " + error.getClass().getSimpleName());
        }
    }

    private String applyMarketTask(com.google.gson.JsonObject task) throws Exception {
        UUID uuid=UUID.fromString(task.get("uuid").getAsString());
        String id=task.get("id").getAsString(), kind=task.get("kind").getAsString();
        int quantity=task.get("quantity").getAsInt();
        if(!id.matches("[0-9a-f]{64}") || quantity<1 || quantity>230 || !(kind.equals("withdraw") || kind.equals("deliver"))) throw new IOException("Invalid market task");
        Player player=getServer().getPlayer(uuid);
        if(player!=null && (!player.isOnline() || !isAuthenticated(player))) return null;
        Path file=getServer().getLevelDirectory().resolve("players/data").resolve(uuid+".dat");
        InventoryNbt nbt=null;
        String receipt;
        var key=new NamespacedKey(this,"marketplace");
        if(player!=null) receipt=player.getPersistentDataContainer().getOrDefault(key,org.bukkit.persistence.PersistentDataType.STRING,"");
        else {
            if(!Files.isRegularFile(file)) return null;
            nbt=InventoryNbt.read(Files.readAllBytes(file));
            receipt=nbt.marketReceipt();
        }
        com.google.gson.JsonObject result;
        if(!receipt.isEmpty() && com.google.gson.JsonParser.parseString(receipt).getAsJsonObject().get("id").getAsString().equals(id)) {
            result=com.google.gson.JsonParser.parseString(receipt).getAsJsonObject();
        } else {
            result=new com.google.gson.JsonObject(); result.addProperty("id",id); result.addProperty("uuid",uuid.toString());
            result.addProperty("status","done");
            int slot;
            ItemStack current;
            if(kind.equals("withdraw")) {
                slot=task.get("slot").getAsInt();
                if(slot<0 || slot>40) throw new IOException("Invalid market slot");
                current=player!=null ? player.getInventory().getItem(slot) : nbt.slots().containsKey(slot) ? ItemStack.deserializeBytes(nbt.itemBytes(nbt.slots().get(slot))) : null;
                String expected=task.get("fingerprint").getAsString();
                if(current==null || current.isEmpty() || current.getAmount()<quantity || !expected.equals(InventoryNbt.fingerprint(current.serializeAsBytes()))) {
                    result.addProperty("status","conflict");
                } else {
                    ItemStack escrow=current.clone(); escrow.setAmount(quantity);
                    String bytes=java.util.Base64.getEncoder().encodeToString(escrow.serializeAsBytes());
                    // NBT strings have a 65535-byte encoding limit, including
                    // our receipt. Fail before changing an oversized stack.
                    if(bytes.length()>60000) result.addProperty("status","conflict");
                    else {
                        result.addProperty("item_bytes",bytes);
                        ItemStack left=current.clone(); left.setAmount(current.getAmount()-quantity);
                        if(player!=null) player.getInventory().setItem(slot,left.isEmpty()?null:left);
                        else nbt.replaceMarketItem(slot,left.isEmpty()?null:InventoryNbt.read(left.serializeAsBytes()).root);
                    }
                }
            } else {
                String bytes=task.get("item_bytes").getAsString();
                if(bytes.length()>60000) throw new IOException("Market item too large");
                current=ItemStack.deserializeBytes(java.util.Base64.getDecoder().decode(bytes));
                if(current.isEmpty() || current.getMaxStackSize()<1) throw new IOException("Invalid market stack");
                var empty=new ArrayList<Integer>();
                var offlineSlots=nbt==null?null:nbt.slots();
                int needed=(quantity+current.getMaxStackSize()-1)/current.getMaxStackSize();
                for(int i=0;i<36;i++) {
                    ItemStack existing=player!=null ? player.getInventory().getItem(i) : null;
                    if(player!=null ? existing==null || existing.isEmpty() : !offlineSlots.containsKey(i)) empty.add(i);
                }
                // Never drop or overwrite items. Reserve all needed storage
                // slots before making the first change, then save one receipt.
                if(empty.size()<needed) return null;
                int left=quantity;
                for(int i=0;i<needed;i++) {
                    ItemStack part=current.clone(); part.setAmount(Math.min(left,current.getMaxStackSize()));
                    left-=part.getAmount(); slot=empty.get(i);
                    if(player!=null) player.getInventory().setItem(slot,part);
                    else nbt.replaceMarketItem(slot,InventoryNbt.read(part.serializeAsBytes()).root);
                }
            }
            if(player!=null) player.getPersistentDataContainer().set(key,org.bukkit.persistence.PersistentDataType.STRING,result.toString());
            else { nbt.marketReceipt(result.toString()); nbt.save(file); }
        }
        String snapshot;
        if(player!=null) {
            player.saveData();
            if(!result.toString().equals(InventoryNbt.read(Files.readAllBytes(file)).marketReceipt())) throw new IOException("Market receipt not saved");
            snapshot=inventorySnapshot(player);
        } else {
            String[] slots=new String[41]; java.util.Arrays.fill(slots,"null");
            // Build from the committed file, retaining every unrelated item.
            for(var entry:nbt.slots().entrySet()) slots[entry.getKey()]=slotJson(ItemStack.deserializeBytes(nbt.itemBytes(entry.getValue())));
            snapshot="{\"slots\":["+String.join(",",slots)+"]}";
        }
        inventoryPending.remove(uuid); inventoryAccepted.remove(uuid); inventoryAcceptedAt.remove(uuid);
        result.add("slots",com.google.gson.JsonParser.parseString(snapshot).getAsJsonObject().get("slots"));
        return result.toString();
    }

    private void sendInventories() {
        if (!inventoryUrl.isBlank()) {
            if (!iconsQueued.isEmpty()) {
                sendIconBatch(new ArrayList<>(iconsQueued), requestTimeout);
            }
            Map<UUID, String> pending = new LinkedHashMap<>();
            for (Map.Entry<UUID, String> entry : inventoryPending.entrySet()) {
                pending.put(entry.getKey(), entry.getValue());
                if (pending.size() >= 25) {
                    break;
                }
            }
            for (Map.Entry<UUID, String> entry : pending.entrySet()) {
                HttpResponse<String> response = post(inventoryUrl, entry.getValue(), requestTimeout);
                if (response != null && response.statusCode() == 200) {
                    inventoryPending.remove(entry.getKey(), entry.getValue());
                    inventoryAccepted.put(entry.getKey(), entry.getValue());
                    inventoryAcceptedAt.put(entry.getKey(), System.currentTimeMillis());
                } else if (response == null) {
                    // The panel is unreachable; keep everything for the next pass.
                    break;
                }
            }
        }
    }

    /**
     * Uploads one batch of item textures from the official version-matched
     * client PNGs packaged in this plugin, so an icon always matches the version that produced
     * the snapshot. Keys without a texture file are marked accepted so they
     * are never retried; the panel then answers no icon and the website shows
     * its fallback artwork with the item name. A failed batch stays unmarked
     * and is re-queued by the next sample.
     */
    private void sendIconBatch(List<String> keys, Duration timeout) {
        Map<String, String> encoded = new LinkedHashMap<>();
        for (String key : keys) {
            if (encoded.size() >= 100) {
                break;
            }
            byte[] bytes = iconBytes(key);
            if (bytes == null) {
                iconsAccepted.add(key);
            } else {
                encoded.put(key, java.util.Base64.getEncoder().encodeToString(bytes));
            }
        }
        if (encoded.isEmpty()) {
            iconsQueued.removeAll(keys);
            return;
        }
        StringBuilder body = new StringBuilder("{\"items\":[");
        boolean first = true;
        for (Map.Entry<String, String> entry : encoded.entrySet()) {
            if (!first) body.append(',');
            first = false;
            body.append("{\"key\":\"").append(jsonEscape(entry.getKey()))
                .append("\",\"icon\":\"").append(entry.getValue()).append("\"}");
        }
        body.append("]}");
        HttpResponse<String> response = post(iconsUrl, body.toString(), timeout);
        if (response != null && response.statusCode() == 200) {
            iconsAccepted.addAll(encoded.keySet());
        }
        iconsQueued.removeAll(keys);
    }

    /**
     * The item's texture from the version-matched client assets in this plugin jar: most items live under
     * {@code textures/item}, most blocks under {@code textures/block}, and
     * armor under {@code textures/item/armor}. The first readable PNG wins;
     * nothing here is generated or substituted.
     */
    private byte[] iconBytes(String key) {
        String name = key.startsWith("minecraft:") ? key.substring("minecraft:".length()) : key;
        for (String path : List.of(
            "assets/minecraft/textures/item/" + name + ".png",
            "assets/minecraft/textures/block/" + name + ".png",
            "assets/minecraft/textures/item/armor/" + name + ".png")) {
            try (InputStream stream = getResource(path)) {
                if (stream == null) {
                    continue;
                }
                byte[] bytes = stream.readAllBytes();
                if (bytes.length >= 4 && (bytes[0] & 0xFF) == 0x89 && bytes[1] == 'P' && bytes[2] == 'N' && bytes[3] == 'G') {
                    return bytes;
                }
            } catch (IOException error) {
                // Try the next candidate path.
            }
        }
        return null;
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
            case 422 -> "That website account already has four linked Minecraft accounts. Unlink one on the website, then retry.";
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

    /** Bounded NBT codec. Keeps every player tag, and atomically replaces only the
     * selected inventory entry plus a replay receipt in Bukkit's persistent data. */
    static final class InventoryNbt {
        static final String RECEIPT = "linkbridge:inventory_delete";
        record Tag(int type, Object value) {}
        record Tags(int type, List<Tag> values) {}
        final Map<String, Tag> root;
        private InventoryNbt(Map<String, Tag> root) { this.root = root; }
        static Map<String, Tag> compound(Tag tag) throws IOException {
            if (tag == null || tag.type != 10) throw new IOException("Expected compound");
            @SuppressWarnings("unchecked") var map = (Map<String, Tag>) tag.value;
            return map;
        }
        static InventoryNbt read(byte[] compressed) throws IOException {
            try (var gzip = new GZIPInputStream(new ByteArrayInputStream(compressed))) {
                byte[] bytes = gzip.readNBytes(16 * 1024 * 1024 + 1);
                if (bytes.length > 16 * 1024 * 1024) throw new IOException("Player data too large");
                var in = new DataInputStream(new ByteArrayInputStream(bytes));
                if (in.readUnsignedByte() != 10) throw new IOException("Invalid NBT root");
                in.readUTF();
                var result = new InventoryNbt(compound(readTag(in, 10, 0)));
                if (in.available() != 0) throw new IOException("Trailing NBT");
                return result;
            }
        }
        static int length(DataInputStream in) throws IOException {
            int n = in.readInt();
            if (n < 0 || n > 1048576) throw new IOException("Invalid NBT length");
            return n;
        }
        private static Tag readTag(DataInputStream in, int type, int depth) throws IOException {
            if (depth > 64) throw new IOException("NBT nesting limit");
            Object value = switch (type) {
                case 1 -> in.readByte(); case 2 -> in.readShort(); case 3 -> in.readInt();
                case 4 -> in.readLong(); case 5 -> in.readFloat(); case 6 -> in.readDouble();
                case 7 -> { byte[] a = new byte[length(in)]; in.readFully(a); yield a; }
                case 8 -> in.readUTF();
                case 9 -> {
                    int child = in.readUnsignedByte(), count = length(in);
                    if (child == 0 && count != 0) throw new IOException("Invalid list");
                    var list = new ArrayList<Tag>();
                    for (int i=0; i<count; i++) list.add(readTag(in, child, depth+1));
                    yield new Tags(child, list);
                }
                case 10 -> {
                    var map = new TreeMap<String, Tag>();
                    int child;
                    while ((child = in.readUnsignedByte()) != 0) {
                        String name = in.readUTF();
                        if (map.put(name, readTag(in, child, depth+1)) != null) throw new IOException("Duplicate tag");
                    }
                    yield map;
                }
                case 11 -> { int[] a = new int[length(in)]; for(int i=0;i<a.length;i++) a[i]=in.readInt(); yield a; }
                case 12 -> { long[] a = new long[length(in)]; for(int i=0;i<a.length;i++) a[i]=in.readLong(); yield a; }
                default -> throw new IOException("Unknown NBT type");
            };
            return new Tag(type, value);
        }
        private static void writeTag(DataOutputStream out, Tag tag) throws IOException {
            switch(tag.type) {
                case 1 -> out.writeByte((Byte)tag.value); case 2 -> out.writeShort((Short)tag.value);
                case 3 -> out.writeInt((Integer)tag.value); case 4 -> out.writeLong((Long)tag.value);
                case 5 -> out.writeFloat((Float)tag.value); case 6 -> out.writeDouble((Double)tag.value);
                case 7 -> { var a=(byte[])tag.value; out.writeInt(a.length); out.write(a); }
                case 8 -> out.writeUTF((String)tag.value);
                case 9 -> { var a=(Tags)tag.value; out.writeByte(a.type); out.writeInt(a.values.size()); for(var t:a.values) writeTag(out,t); }
                case 10 -> {
                    for(var entry:new TreeMap<>(compound(tag)).entrySet()) {
                        out.writeByte(entry.getValue().type); out.writeUTF(entry.getKey()); writeTag(out,entry.getValue());
                    }
                    out.writeByte(0);
                }
                case 11 -> { var a=(int[])tag.value; out.writeInt(a.length); for(int n:a) out.writeInt(n); }
                case 12 -> { var a=(long[])tag.value; out.writeInt(a.length); for(long n:a) out.writeLong(n); }
                default -> throw new IOException("Unknown NBT type");
            }
        }
        byte[] bytes() throws IOException {
            var buffer = new ByteArrayOutputStream();
            try(var out=new DataOutputStream(new GZIPOutputStream(buffer))) {
                out.writeByte(10); out.writeUTF(""); writeTag(out,new Tag(10,root));
            }
            return buffer.toByteArray();
        }
        static String fingerprint(byte[] item) throws Exception { return fingerprint(read(item).root); }
        static String fingerprint(Map<String, Tag> item) throws Exception {
            var normalized = new TreeMap<>(item);
            normalized.remove("DataVersion"); normalized.remove("Slot"); normalized.remove("slot");
            var buffer = new ByteArrayOutputStream();
            writeTag(new DataOutputStream(buffer), new Tag(10,normalized));
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(buffer.toByteArray()));
        }
        Tags inventory() throws IOException {
            Tag tag = root.get("Inventory");
            if(tag == null) tag = root.get("inventory");
            if(tag == null) return new Tags(10,new ArrayList<>());
            if(tag.type != 9) throw new IOException("Unsupported inventory format");
            Tags tags = (Tags)tag.value;
            if(tags.type != 10 && !(tags.type == 0 && tags.values.isEmpty())) throw new IOException("Unsupported inventory entries");
            return tags;
        }
        static int slot(Map<String, Tag> entry) throws IOException {
            Tag tag = entry.getOrDefault("Slot",entry.get("slot"));
            if(tag == null || !(tag.value instanceof Number n)) throw new IOException("Unsupported slot format");
            int raw = n.intValue() & 255;
            if(raw <= 35) return raw;
            if(raw >= 100 && raw <= 103) return raw - 64;
            if(raw == 150) return 40;
            throw new IOException("Unsupported inventory slot");
        }
        static Map<String, Tag> item(Map<String, Tag> entry) throws IOException {
            return entry.containsKey("item") ? compound(entry.get("item")) : entry;
        }
        // Since 1.21.5, armor and off hand are in the equipment compound,
        // while storage remains in Inventory. Never treat those as empty storage.
        static final String[] EQUIPMENT = {"feet", "legs", "chest", "head", "offhand"};
        Map<Integer, Map<String,Tag>> slots() throws IOException {
            var result = new TreeMap<Integer,Map<String,Tag>>();
            for(var tag:inventory().values) {
                var entry = compound(tag);
                if(result.put(slot(entry),item(entry)) != null) throw new IOException("Duplicate slot");
            }
            if(root.containsKey("equipment")) {
                var equipment = compound(root.get("equipment"));
                for(int i=0;i<EQUIPMENT.length;i++) {
                    var entry = equipment.get(EQUIPMENT[i]);
                    if(entry != null && result.put(i+36,compound(entry)) != null) throw new IOException("Duplicate equipment");
                }
            }
            return result;
        }
        boolean delete(int index, String expected, String id) throws Exception {
            if((id + ":deleted").equals(receipt())) return true;
            if((id + ":conflict").equals(receipt())) return false;
            var current = slots().get(index);
            if(current == null || !expected.equals(fingerprint(current))) {
                receipt(id + ":conflict");
                return false;
            }
            if(index >= 36 && root.containsKey("equipment")
                && compound(root.get("equipment")).containsKey(EQUIPMENT[index-36])) {
                compound(root.get("equipment")).remove(EQUIPMENT[index-36]);
            } else {
                inventory().values.removeIf(tag -> {
                    try { return slot(compound(tag)) == index; }
                    catch(IOException error) { throw new java.io.UncheckedIOException(error); }
                });
            }
            receipt(id + ":deleted");
            return true;
        }
        // Lossless partial escrow / insertion in the modern saved-player layout.
        void replaceMarketItem(int index, Map<String,Tag> replacement) throws IOException {
            if(index<0 || index>40) throw new IOException("Invalid slot");
            if(index>=36 && root.containsKey("equipment")) {
                var equipment=compound(root.get("equipment"));
                if(replacement==null) equipment.remove(EQUIPMENT[index-36]);
                else {
                    var copy=new TreeMap<>(replacement); copy.remove("DataVersion"); copy.remove("Slot"); copy.remove("slot");
                    equipment.put(EQUIPMENT[index-36],new Tag(10,copy));
                }
            } else {
                Tags entries=inventory();
                if(!root.containsKey("Inventory") && !root.containsKey("inventory")) root.put("Inventory",new Tag(9,entries));
                entries.values.removeIf(tag -> {
                    try { return slot(compound(tag))==index; }
                    catch(IOException error) { throw new java.io.UncheckedIOException(error); }
                });
                if(replacement!=null) {
                    var copy=new TreeMap<>(replacement); copy.remove("DataVersion"); copy.remove("slot");
                    copy.put("Slot",new Tag(1,(byte)(index<36?index:index==40?150:index+64)));
                    entries.values.add(new Tag(10,copy));
                }
            }
        }
        String economyReceipt() throws IOException {
            Tag values=root.get("BukkitValues");if(values==null)return "";
            Tag value=compound(values).get("linkbridge:economy_task");
            return value!=null&&value.type==8?(String)value.value:"";
        }
        String marketReceipt() throws IOException {
            Tag values=root.get("BukkitValues");
            if(values==null) return "";
            Tag value=compound(values).get("linkbridge:marketplace");
            return value!=null && value.type==8 ? (String)value.value : "";
        }
        void marketReceipt(String receipt) throws IOException {
            if(!root.containsKey("BukkitValues")) root.put("BukkitValues",new Tag(10,new TreeMap<String,Tag>()));
            compound(root.get("BukkitValues")).put("linkbridge:marketplace",new Tag(8,receipt));
        }
        String receipt() throws IOException {
            Tag values = root.get("BukkitValues");
            if(values == null) return "";
            Tag receipt = compound(values).get(RECEIPT);
            return receipt != null && receipt.type == 8 ? (String)receipt.value : "";
        }
        void receipt(String id) throws IOException {
            if(!root.containsKey("BukkitValues")) root.put("BukkitValues",new Tag(10,new TreeMap<String,Tag>()));
            compound(root.get("BukkitValues")).put(RECEIPT,new Tag(8,id));
        }
        byte[] itemBytes(Map<String,Tag> item) throws IOException {
            var copy = new TreeMap<>(item);
            copy.remove("Slot"); copy.remove("slot");
            Tag version = root.get("DataVersion");
            if(version == null) throw new IOException("Missing data version");
            copy.put("DataVersion",version);
            return new InventoryNbt(copy).bytes();
        }
        void save(Path file) throws IOException {
            Path staged = Files.createTempFile(file.getParent(), ".linkbridge-", ".dat");
            try {
                try(var channel=java.nio.channels.FileChannel.open(staged,StandardOpenOption.WRITE)) {
                    var buffer=java.nio.ByteBuffer.wrap(bytes());
                    while(buffer.hasRemaining()) channel.write(buffer);
                    channel.force(true);
                }
                Files.copy(file,file.resolveSibling(file.getFileName()+".linkbridge-backup"),StandardCopyOption.REPLACE_EXISTING);
                Files.move(staged,file,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
            } finally { Files.deleteIfExists(staged); }
        }
    }
}
