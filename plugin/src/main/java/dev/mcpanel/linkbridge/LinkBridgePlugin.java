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
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Comparator;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Handler;
import java.util.logging.LogRecord;
import net.kyori.adventure.text.Component;
import org.bukkit.Color;
import org.bukkit.Sound;
import org.bukkit.Chunk;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.Particle;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.enchantments.Enchantment;
import org.bukkit.entity.ArmorStand;
import org.bukkit.entity.Creeper;
import org.bukkit.entity.ItemFrame;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.entity.TNTPrimed;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockExplodeEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.enchantment.EnchantItemEvent;
import org.bukkit.event.entity.EntityBreedEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityDeathEvent;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.entity.EntityPickupItemEvent;
import org.bukkit.event.entity.EntityTargetLivingEntityEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.hanging.HangingBreakByEntityEvent;
import org.bukkit.event.inventory.CraftItemEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.event.player.PlayerAdvancementDoneEvent;
import org.bukkit.event.player.PlayerBedEnterEvent;
import org.bukkit.event.player.PlayerBedLeaveEvent;
import org.bukkit.event.player.PlayerFishEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.player.PlayerItemBreakEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.ItemFlag;
import org.bukkit.inventory.PlayerInventory;
import org.bukkit.inventory.meta.Damageable;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitRunnable;

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
     * The panel validates every reported counter as an unsigned 32-bit value, so
     * the counters saturate here. Without the ceiling one absurd event (an
     * infinite-damage hit rounding to {@code Long.MAX_VALUE}) produced a report
     * the panel rejected with 400, which then blocked the whole outbox.
     */
    private static final long MAX_COUNTER = 4_294_967_295L;

    /**
     * No honest single hit reaches this many centi-hearts (1000 hearts); a larger
     * value is a hostile or broken damage source and must not consume the whole
     * counter budget.
     */
    private static final long MAX_EVENT_CENTI_HEARTS = 100_000L;

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
    private String marketplaceListingsUrl = "";
    private String marketplaceBuyUrl = "";
    private String marketplaceCancelUrl = "";
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
        if (getCommand("mail") != null) {
            getCommand("mail").setExecutor(this);
            getCommand("mail").setTabCompleter((sender, command, alias, args) -> {
                if (args.length == 1) {
                    return List.of("claim", "list").stream().filter(s -> s.startsWith(args[0].toLowerCase(Locale.ROOT))).toList();
                }
                return List.of();
            });
        }
        if (getCommand("clan") != null) {
            getCommand("clan").setExecutor(this);
            getCommand("clan").setTabCompleter((sender, command, alias, args) -> {
                if (!(sender instanceof Player player) || !isAuthenticated(player)) return List.of();
                if (args.length == 1) {
                    String prefix = args[0].toLowerCase(Locale.ROOT);
                    return List.of("create", "invite", "join", "leave", "home", "sethome", "bank", "info", "ally", "enemy", "neutral", "disband")
                        .stream().filter(s -> s.startsWith(prefix)).toList();
                }
                if (args.length == 2 && args[0].equalsIgnoreCase("bank")) {
                    String prefix = args[1].toLowerCase(Locale.ROOT);
                    return List.of("deposit", "withdraw", "balance")
                        .stream().filter(s -> s.startsWith(prefix)).toList();
                }
                return List.of();
            });
        }
        getServer().getPluginManager().registerEvents(this, this);
        getServer().getScheduler().runTaskTimerAsynchronously(this, this::syncSkins, 40L, 100L);
        getServer().getScheduler().runTaskTimerAsynchronously(this, this::syncClans, 50L, 200L);

        initializeEconomy();
        initializeEconomyServices();
        initializePrivateAndMining();
        setupOverworldBorder();
        initBlueMapIntegration();
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
        getServer().getScheduler()
            .runTaskTimerAsynchronously(this, this::syncChat, 20L, 20L);
        setupAdminLogCapture();
        getServer().getScheduler()
            .runTaskTimerAsynchronously(this, this::syncAdmin, 25L, 25L);
        getServer().getScheduler()
            .runTaskTimer(this, this::updateTabList, 10L, 3L);
    }

    @Override
    public void onDisable() {
        if (adminLog4jAppender != null) {
            try {
                org.apache.logging.log4j.core.LoggerContext context =
                    (org.apache.logging.log4j.core.LoggerContext) org.apache.logging.log4j.LogManager.getContext(false);
                context.getConfiguration().getRootLogger().removeAppender(adminLog4jAppender.getName());
                adminLog4jAppender.stop();
                context.updateLoggers();
            } catch (Throwable ignored) {}
        }
        if (adminLogHandler != null) {
            try {
                java.util.logging.Logger.getLogger("").removeHandler(adminLogHandler);
            } catch (Exception ignored) {}
        }
        for (ActiveBreach breach : activeBreaches.values()) {
            for (BreachedBlock bb : breach.restoredBlocks) {
                if (bb.location.getWorld() != null) {
                    bb.location.getBlock().setBlockData(bb.blockData, false);
                }
            }
        }
        activeBreaches.clear();
        for (org.bukkit.scheduler.BukkitTask task : activeTeleportWarmups.values()) {
            try { task.cancel(); } catch (Exception ignored) {}
        }
        activeTeleportWarmups.clear();

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
        marketplaceListingsUrl = base + "/internal/marketplace/listings";
        marketplaceBuyUrl = base + "/internal/marketplace/buy";
        marketplaceCancelUrl = base + "/internal/marketplace/cancel";
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
            if (args.length > 2 || (args.length >= 1 && !args[0].equalsIgnoreCase("start")) || (args.length == 2 && !List.of("hunting","fishing","farming","mining").contains(args[1].toLowerCase(Locale.ROOT)))) {
                player.sendMessage("[Quests] Usage: /quests (opens visual GUI) or /quests start [hunting|fishing|farming|mining]");
                return true;
            }
            if (!allowAttempt(player.getUniqueId())) {
                player.sendMessage("[Quests] Wait a few seconds and try again.");
                return true;
            }
            if (args.length == 0) {
                openQuestsGui(player);
                return true;
            }
            queryContract(player, true, true, args.length == 2 ? args[1].toLowerCase(Locale.ROOT) : "hunting");
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
        if (command.getName().equalsIgnoreCase("sell")) {
            if (!allowAttempt(player.getUniqueId())) {
                player.sendMessage("[Market] Wait a few seconds and try again.");
                return true;
            }
            sellCommand(player, args);
            return true;
        }
        if (command.getName().equalsIgnoreCase("market") || command.getName().equalsIgnoreCase("ah")) {
            if (!allowAttempt(player.getUniqueId())) {
                player.sendMessage("[Market] Wait a few seconds and try again.");
                return true;
            }
            marketCommand(player, args);
            return true;
        }
        if (command.getName().equalsIgnoreCase("ps") || command.getName().equalsIgnoreCase("private") || command.getName().equalsIgnoreCase("protection")) {
            if (!allowAttempt(player.getUniqueId())) {
                player.sendMessage("[Private] Wait a few seconds and try again.");
                return true;
            }
            psCommand(player, args);
            return true;
        }
        if (command.getName().equalsIgnoreCase("home")) {
            if (!allowAttempt(player.getUniqueId())) {
                player.sendMessage("[Private] Wait a few seconds and try again.");
                return true;
            }
            String targetIndex = (args.length >= 1) ? args[0] : "1";
            psCommand(player, new String[]{"tp", targetIndex});
            return true;
        }
        if (command.getName().equalsIgnoreCase("mine")) {
            if (!allowAttempt(player.getUniqueId())) {
                player.sendMessage("[Mine] Wait a few seconds and try again.");
                return true;
            }
            mineCommand(player, args);
            return true;
        }
        if (command.getName().equalsIgnoreCase("minershop")) {
            if (!allowAttempt(player.getUniqueId())) {
                player.sendMessage("[Miners] Wait a few seconds and try again.");
                return true;
            }
            minershopCommand(player, args);
            return true;
        }
        if (command.getName().equalsIgnoreCase("raid")) {
            if (!allowAttempt(player.getUniqueId())) {
                player.sendMessage("[Raid] Wait a few seconds and try again.");
                return true;
            }
            raidCommand(player, args);
            return true;
        }
        if (command.getName().equalsIgnoreCase("mail")) {
            if (!allowAttempt(player.getUniqueId())) {
                player.sendMessage("[Mail] Wait a few seconds and try again.");
                return true;
            }
            handleMailCommand(player, args);
            return true;
        }
        if (command.getName().equalsIgnoreCase("clan") || command.getName().equalsIgnoreCase("f") || command.getName().equalsIgnoreCase("faction") || command.getName().equalsIgnoreCase("clans")) {
            if (!allowAttempt(player.getUniqueId())) {
                player.sendMessage("[Clan] Wait a few seconds and try again.");
                return true;
            }
            handleClanCommand(player, args);
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

    static final class SellRules {
        static long parseUnitPrice(String arg) {
            long p = Long.parseLong(arg);
            if (p < 1 || p > 1_000_000_000L) throw new IllegalArgumentException("unit price out of range: " + p);
            return p;
        }
        static long parseLotPrice(String arg, long unitPrice, int quantity) {
            if (arg != null) {
                long p = Long.parseLong(arg);
                if (p < 1 || p > 1_000_000_000L) throw new IllegalArgumentException("lot price out of range: " + p);
                return p;
            }
            long p = Math.multiplyExact(unitPrice, (long) quantity);
            if (p < 1 || p > 1_000_000_000L) throw new ArithmeticException("lot price overflow: " + p);
            return p;
        }
        static String formatItemName(String customName, String typeName) {
            if (customName != null && !customName.trim().isEmpty()) return customName.trim();
            if (typeName == null || typeName.isEmpty()) return "Unknown";
            String[] words = typeName.toLowerCase(Locale.ROOT).split("_");
            StringBuilder sb = new StringBuilder();
            for (String word : words) {
                if (!word.isEmpty()) {
                    if (sb.length() > 0) sb.append(' ');
                    sb.append(Character.toUpperCase(word.charAt(0))).append(word.substring(1));
                }
            }
            return sb.toString();
        }
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
            unitPrice = SellRules.parseUnitPrice(args[0]);
        } catch (Exception e) {
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
        try {
            lotPrice = SellRules.parseLotPrice(args.length == 2 ? args[1] : null, unitPrice, quantity);
        } catch (ArithmeticException e) {
            player.sendMessage("[Market] Total lot price exceeds 1,000,000,000 coins. Specify a custom stack price.");
            return;
        } catch (Exception e) {
            player.sendMessage("[Market] Price for stack must be a positive integer between 1 and 1,000,000,000.");
            return;
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
        String customDisplayName = (item.getItemMeta() != null && item.getItemMeta().hasDisplayName())
            ? item.getItemMeta().getDisplayName()
            : null;
        String displayName = SellRules.formatItemName(customDisplayName, item.getType().name());
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

    public static final class RepairRules {
        public static boolean isIronEquipment(String materialName) {
            if (materialName == null) return false;
            return materialName.startsWith("IRON_");
        }

        public static boolean isGoldenArmor(String materialName) {
            if (materialName == null) return false;
            return materialName.equals("GOLDEN_HELMET") || materialName.equals("GOLDEN_CHESTPLATE")
                || materialName.equals("GOLDEN_LEGGINGS") || materialName.equals("GOLDEN_BOOTS");
        }

        public static boolean isDiamondArmor(String materialName) {
            if (materialName == null) return false;
            return materialName.equals("DIAMOND_HELMET") || materialName.equals("DIAMOND_CHESTPLATE")
                || materialName.equals("DIAMOND_LEGGINGS") || materialName.equals("DIAMOND_BOOTS");
        }

        public static boolean isNetheriteArmor(String materialName) {
            if (materialName == null) return false;
            return materialName.equals("NETHERITE_HELMET") || materialName.equals("NETHERITE_CHESTPLATE")
                || materialName.equals("NETHERITE_LEGGINGS") || materialName.equals("NETHERITE_BOOTS");
        }

        public static boolean isRepairableMaterial(String materialName) {
            return isIronEquipment(materialName) || isGoldenArmor(materialName)
                || isDiamondArmor(materialName) || isNetheriteArmor(materialName);
        }

        public static Long unitPrice(String materialName) {
            if (isIronEquipment(materialName)) return 10L;
            if (isGoldenArmor(materialName)) return 15L;
            if (isDiamondArmor(materialName)) return 60L;
            if (isNetheriteArmor(materialName)) return 175L;
            return null;
        }
    }

    public static final class PrivateRules {
        public static final long[] PRICES = {500L, 20000L, 50000L};
        public static final int MAX_BLOCKS = 3;

        public static long nextBlockPrice(int currentCount) {
            if (currentCount < 0 || currentCount >= MAX_BLOCKS) return -1L;
            return PRICES[currentCount];
        }

        public static int radiusToSize(int radius) {
            return switch (radius) {
                case 16 -> 32;
                case 40 -> 80;
                case 80 -> 160;
                case 128 -> 256;
                default -> radius * 2;
            };
        }

        public static int radiusToChunks(int radius) {
            return switch (radius) {
                case 16 -> 2;
                case 40 -> 5;
                case 80 -> 10;
                case 128 -> 16;
                default -> Math.max(1, (radius * 2) / 16);
            };
        }

        public static int sizeToRadius(int size) {
            return switch (size) {
                case 32 -> 16;
                case 80 -> 40;
                case 160 -> 80;
                case 256 -> 128;
                default -> size / 2;
            };
        }

        public static boolean isInside(int x, int z, int coreX, int coreZ, int radius) {
            return Math.abs(x - coreX) <= radius && Math.abs(z - coreZ) <= radius;
        }

        public static boolean canAccess(UUID player, UUID owner, List<UUID> members) {
            if (player == null || owner == null) return false;
            if (player.equals(owner)) return true;
            return members != null && members.contains(player);
        }

        public static boolean canExplosionDamageZone(UUID triggerPlayer, UUID owner, List<UUID> members) {
            return canAccess(triggerPlayer, owner, members);
        }

        public static boolean canOpenInRaid(String materialName) {
            if (materialName == null) return false;
            return materialName.contains("CHEST")
                || materialName.contains("BARREL")
                || materialName.contains("SHULKER_BOX");
        }

        public static boolean isDoorOrSwitch(String materialName) {
            if (materialName == null) return false;
            return materialName.contains("DOOR")
                || materialName.contains("TRAPDOOR")
                || materialName.contains("GATE")
                || materialName.contains("BUTTON")
                || materialName.contains("LEVER");
        }

        public static boolean isProtectedInteractable(String materialName) {
            if (materialName == null) return false;
            return canOpenInRaid(materialName)
                || isDoorOrSwitch(materialName)
                || materialName.contains("FURNACE")
                || materialName.contains("SMOKER")
                || materialName.contains("HOPPER");
        }

        public static boolean canTntDamageBlock(String materialName, boolean isMember, boolean isRaidTnt, boolean isZoneUnderRaid) {
            if (isMember) return true;
            if (isRaidTnt && isZoneUnderRaid) {
                return !canOpenInRaid(materialName);
            }
            return false;
        }
    }

    public static final class FuelRules {
        public static final long MAX_STORED_FUEL = 72 * 3600L;

        public static long fuelDuration(int tier) {
            return switch (tier) {
                case 1 -> 7200L;
                case 2 -> 10800L;
                case 3 -> 14400L;
                case 4 -> 21600L;
                default -> 0L;
            };
        }

        public static int fuelRadius(int tier) {
            return switch (tier) {
                case 1 -> 16;
                case 2 -> 40;
                case 3 -> 80;
                case 4 -> 128;
                default -> 16;
            };
        }

        public static int calculateNewTier(int currentTier, int crystalTier) {
            return Math.max(1, Math.max(currentTier, crystalTier));
        }

        public static long calculateNewFuel(long currentFuelSeconds, int crystalTier) {
            return Math.min(MAX_STORED_FUEL, Math.max(0L, currentFuelSeconds) + fuelDuration(crystalTier));
        }

        public static int oreTier(String materialName) {
            if (materialName == null) return 0;
            if (materialName.contains("COPPER")) return 1;
            if (materialName.contains("LAPIS")) return 2;
            if (materialName.contains("REDSTONE")) return 3;
            if (materialName.contains("AMETHYST") || materialName.contains("EMERALD") || materialName.contains("ECHO")) return 4;
            return 0;
        }

        public static boolean isNonFuelOre(String materialName) {
            if (materialName == null) return false;
            String name = materialName.toUpperCase(Locale.ROOT);
            if (name.contains("COPPER") || name.contains("LAPIS") || name.contains("REDSTONE")
                || name.contains("EMERALD") || name.contains("AMETHYST") || name.contains("ECHO")) {
                return false;
            }
            return name.contains("COAL")
                || name.contains("IRON")
                || name.contains("GOLD")
                || name.contains("DIAMOND")
                || name.contains("NETHERITE")
                || name.contains("QUARTZ")
                || name.contains("DEBRIS");
        }
    }

    public static final class PickaxeRules {
        public static final long[] PRICES = {150L, 1000L, 5000L, 20000L};

        public static long pickaxePrice(int tier) {
            if (tier < 1 || tier > 4) return -1L;
            return PRICES[tier - 1];
        }

        public static String pickaxeName(int tier) {
            return switch (tier) {
                case 1 -> "Apprentice Prospector Pickaxe";
                case 2 -> "Surveyor Prospector Pickaxe";
                case 3 -> "Excavator Prospector Pickaxe";
                case 4 -> "Master Core Drill";
                default -> "Prospector Pickaxe";
            };
        }

        public static boolean canMineTier(int pickaxeTier, int oreTier) {
            if (oreTier <= 0) return true;
            return pickaxeTier >= oreTier;
        }
    }

    public static final class ExpeditionRules {
        public static final long DURATION_SECONDS = 300L;
        public static final long COOLDOWN_SECONDS = 14400L;

        public static boolean canEnter(long lastEnteredEpoch, long nowEpoch) {
            if (lastEnteredEpoch <= 0) return true;
            return nowEpoch - lastEnteredEpoch >= COOLDOWN_SECONDS;
        }

        public static long remainingCooldown(long lastEnteredEpoch, long nowEpoch) {
            if (lastEnteredEpoch <= 0) return 0L;
            return Math.max(0L, COOLDOWN_SECONDS - (nowEpoch - lastEnteredEpoch));
        }

        public static String formatDuration(long seconds) {
            long s = Math.max(0L, seconds);
            return String.format("%02d:%02d", s / 60, s % 60);
        }
    }

    public static final class RaidRules {
        public static final long BREACH_DURATION_SECONDS = 300L; // 5 minutes
        public static final int BREACH_RADIUS = 3; // 3 blocks
        public static final int FUSE_SECONDS = 10; // 10 seconds
        public static final long CHARGE_PRICE = 20000L;
        public static final long TNT_PRICE = 5000L;
    }

    public static final class BreachedBlock {
        public final Location location;
        public final org.bukkit.block.data.BlockData blockData;
        public BreachedBlock(Location location, org.bukkit.block.data.BlockData blockData) {
            this.location = location;
            this.blockData = blockData;
        }
    }

    public static final class ActiveBreach {
        public final String coreKey;
        public final long expiresAtMs;
        public final List<BreachedBlock> restoredBlocks;
        public ActiveBreach(String coreKey, long expiresAtMs, List<BreachedBlock> restoredBlocks) {
            this.coreKey = coreKey;
            this.expiresAtMs = expiresAtMs;
            this.restoredBlocks = restoredBlocks;
        }
    }

    public static final class PrimedCharge {
        public final String zoneId;
        public final Location location;
        public final UUID planterUuid;
        public final String planterName;
        public int ticksRemaining;
        public PrimedCharge(String zoneId, Location location, UUID planterUuid, String planterName, int ticksRemaining) {
            this.zoneId = zoneId;
            this.location = location;
            this.planterUuid = planterUuid;
            this.planterName = planterName;
            this.ticksRemaining = ticksRemaining;
        }
    }

    public static final class PlacedPrivateBlock {
        public String id;
        public UUID ownerUuid;
        public String ownerName;
        public int blockIndex;
        public String world;
        public int x;
        public int y;
        public int z;
        public boolean placed;
        public int radius;
        public long fuelSeconds;
        public int fuelTier;
        public long tier1Seconds;
        public long tier2Seconds;
        public long tier3Seconds;
        public long tier4Seconds;
        public List<UUID> members = new CopyOnWriteArrayList<>();

        public PlacedPrivateBlock(String id, UUID ownerUuid, String ownerName, int blockIndex,
                                  String world, int x, int y, int z, boolean placed,
                                  int radius, long fuelSeconds, int fuelTier,
                                  long tier1Seconds, long tier2Seconds, long tier3Seconds, long tier4Seconds,
                                  List<UUID> members) {
            this.id = id;
            this.ownerUuid = ownerUuid;
            this.ownerName = ownerName;
            this.blockIndex = blockIndex;
            this.world = world;
            this.x = x;
            this.y = y;
            this.z = z;
            this.placed = placed;
            this.tier1Seconds = Math.max(0L, tier1Seconds);
            this.tier2Seconds = Math.max(0L, tier2Seconds);
            this.tier3Seconds = Math.max(0L, tier3Seconds);
            this.tier4Seconds = Math.max(0L, tier4Seconds);
            if (this.tier1Seconds == 0 && this.tier2Seconds == 0 && this.tier3Seconds == 0 && this.tier4Seconds == 0 && fuelSeconds > 0) {
                switch (fuelTier) {
                    case 1 -> this.tier1Seconds = fuelSeconds;
                    case 2 -> this.tier2Seconds = fuelSeconds;
                    case 3 -> this.tier3Seconds = fuelSeconds;
                    case 4 -> this.tier4Seconds = fuelSeconds;
                    default -> this.tier1Seconds = fuelSeconds;
                }
            }
            this.fuelTier = activeTier();
            this.radius = FuelRules.fuelRadius(this.fuelTier);
            this.fuelSeconds = totalFuelSeconds();
            if (members != null) this.members.addAll(members);
        }

        public PlacedPrivateBlock(String id, UUID ownerUuid, String ownerName, int blockIndex,
                                  String world, int x, int y, int z, boolean placed,
                                  int radius, long fuelSeconds, int fuelTier, List<UUID> members) {
            this(id, ownerUuid, ownerName, blockIndex, world, x, y, z, placed, radius,
                 fuelSeconds, fuelTier,
                 fuelTier == 1 ? fuelSeconds : 0L,
                 fuelTier == 2 ? fuelSeconds : 0L,
                 fuelTier == 3 ? fuelSeconds : 0L,
                 fuelTier == 4 ? fuelSeconds : 0L,
                 members);
        }

        public long totalFuelSeconds() {
            return tier1Seconds + tier2Seconds + tier3Seconds + tier4Seconds;
        }

        public int activeTier() {
            if (tier4Seconds > 0) return 4;
            if (tier3Seconds > 0) return 3;
            if (tier2Seconds > 0) return 2;
            if (tier1Seconds > 0) return 1;
            return 1;
        }

        public long getTierSeconds(int tier) {
            return switch (tier) {
                case 1 -> tier1Seconds;
                case 2 -> tier2Seconds;
                case 3 -> tier3Seconds;
                case 4 -> tier4Seconds;
                default -> 0L;
            };
        }

        public void tickSecond() {
            if (tier4Seconds > 0) {
                tier4Seconds--;
            } else if (tier3Seconds > 0) {
                tier3Seconds--;
            } else if (tier2Seconds > 0) {
                tier2Seconds--;
            } else if (tier1Seconds > 0) {
                tier1Seconds--;
            }
            this.fuelTier = activeTier();
            this.radius = FuelRules.fuelRadius(this.fuelTier);
            this.fuelSeconds = totalFuelSeconds();
        }

        public void addFuel(int tier, long seconds) {
            switch (tier) {
                case 1 -> tier1Seconds = Math.max(0L, tier1Seconds + seconds);
                case 2 -> tier2Seconds = Math.max(0L, tier2Seconds + seconds);
                case 3 -> tier3Seconds = Math.max(0L, tier3Seconds + seconds);
                case 4 -> tier4Seconds = Math.max(0L, tier4Seconds + seconds);
            }
            this.fuelTier = activeTier();
            this.radius = FuelRules.fuelRadius(this.fuelTier);
            this.fuelSeconds = totalFuelSeconds();
        }

        public boolean withdrawFuel(int tier, int crystalCount) {
            long duration = FuelRules.fuelDuration(tier);
            long needed = duration * crystalCount;
            long current = getTierSeconds(tier);
            if (current < needed || needed <= 0) return false;
            switch (tier) {
                case 1 -> tier1Seconds -= needed;
                case 2 -> tier2Seconds -= needed;
                case 3 -> tier3Seconds -= needed;
                case 4 -> tier4Seconds -= needed;
            }
            this.fuelTier = activeTier();
            this.radius = FuelRules.fuelRadius(this.fuelTier);
            this.fuelSeconds = totalFuelSeconds();
            return true;
        }
    }

    public static final class MarketRules {
        public static int parsePage(String input) {
            if (input == null || input.isBlank()) return 1;
            try {
                int page = Integer.parseInt(input.trim());
                return Math.max(1, page);
            } catch (NumberFormatException e) {
                return 1;
            }
        }

        public static long computePurchaseTotal(boolean buyLot, Long unitPrice, Long lotPrice, int quantity, int remaining) {
            if (buyLot) {
                if (lotPrice == null) throw new IllegalArgumentException("Lot purchase not available");
                return lotPrice;
            } else {
                if (unitPrice == null) throw new IllegalArgumentException("Unit purchase not available");
                return Math.multiplyExact(unitPrice, (long) quantity);
            }
        }

        public static int computePurchaseQuantity(boolean buyLot, Long unitPrice, Long lotPrice, int remaining) {
            if (buyLot || unitPrice == null) {
                return remaining;
            }
            return 1;
        }

        public static String formatInventoryTitle(int page, int totalPages, String query) {
            if (query != null && !query.isBlank()) {
                String q = query.length() > 16 ? query.substring(0, 16) + "…" : query;
                return "Market (" + q + ") P." + page + "/" + totalPages;
            }
            return "Marketplace (Page " + page + "/" + totalPages + ")";
        }
    }

    public static final class MarketListingEntry {
        private final String id;
        private final String seller;
        private final String sellerUuid;
        private final boolean isMine;
        private final int remaining;
        private final Long unitPrice;
        private final Long lotPrice;
        private final String displayName;
        private final ItemStack rawItem;

        public MarketListingEntry(String id, String seller, String sellerUuid, boolean isMine, int remaining, Long unitPrice, Long lotPrice, String displayName, ItemStack rawItem) {
            this.id = id;
            this.seller = seller;
            this.sellerUuid = sellerUuid;
            this.isMine = isMine;
            this.remaining = remaining;
            this.unitPrice = unitPrice;
            this.lotPrice = lotPrice;
            this.displayName = displayName;
            this.rawItem = rawItem;
        }

        public String id() { return id; }
        public String seller() { return seller; }
        public String sellerUuid() { return sellerUuid; }
        public boolean isMine() { return isMine; }
        public int remaining() { return remaining; }
        public Long unitPrice() { return unitPrice; }
        public Long lotPrice() { return lotPrice; }
        public String displayName() { return displayName; }
        public ItemStack rawItem() { return rawItem; }
    }

    public static final class MarketHolder implements InventoryHolder {
        private final int page;
        private final int totalPages;
        private final String query;
        private final long buyerCoins;
        private final Map<Integer, MarketListingEntry> listings = new HashMap<>();
        private Inventory inventory;

        public MarketHolder(int page, int totalPages, String query, long buyerCoins) {
            this.page = page;
            this.totalPages = totalPages;
            this.query = query;
            this.buyerCoins = buyerCoins;
        }

        public int getPage() { return page; }
        public int getTotalPages() { return totalPages; }
        public String getQuery() { return query; }
        public long getBuyerCoins() { return buyerCoins; }

        public void putListing(int slot, MarketListingEntry entry) {
            listings.put(slot, entry);
        }

        public MarketListingEntry getListing(int slot) {
            return listings.get(slot);
        }

        public void setInventory(Inventory inventory) {
            this.inventory = inventory;
        }

        @Override
        public Inventory getInventory() {
            return inventory;
        }
    }

    private void marketCommand(Player player, String[] args) {
        if (serviceToken.isBlank() || serviceToken.contains("${")) {
            player.sendMessage("[Market] Marketplace is not configured on this server.");
            return;
        }
        if (args.length == 0) {
            openMarket(player, 1, "");
            return;
        }
        if (args[0].equalsIgnoreCase("search") || args[0].equalsIgnoreCase("find")) {
            if (args.length < 2) {
                player.sendMessage("[Market] Usage: /market search <item or player name>");
                return;
            }
            String query = String.join(" ", java.util.Arrays.copyOfRange(args, 1, args.length)).trim();
            openMarket(player, 1, query);
            return;
        }
        if (args[0].equalsIgnoreCase("page") || args[0].equalsIgnoreCase("p")) {
            if (args.length < 2) {
                player.sendMessage("[Market] Usage: /market page <number>");
                return;
            }
            int page = MarketRules.parsePage(args[1]);
            openMarket(player, page, "");
            return;
        }
        if (args[0].equalsIgnoreCase("cancel") && args.length >= 2) {
            cancelCommand(player, args[1].trim());
            return;
        }
        try {
            int page = Integer.parseInt(args[0].trim());
            openMarket(player, Math.max(1, page), "");
            return;
        } catch (NumberFormatException ignored) {}
        String query = String.join(" ", args).trim();
        openMarket(player, 1, query);
    }

    private void openMarket(Player player, int page, String query) {
        UUID uuid = player.getUniqueId();
        player.sendMessage("[Market] Loading marketplace...");
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            var body = new com.google.gson.JsonObject();
            body.addProperty("buyer_uuid", uuid.toString());
            body.addProperty("page", page);
            body.addProperty("page_size", 45);
            body.addProperty("query", query == null ? "" : query);

            HttpResponse<String> response = post(marketplaceListingsUrl, body.toString(), requestTimeout);
            if (response == null || response.statusCode() != 200) {
                getServer().getScheduler().runTask(this, () -> {
                    if (player.isOnline() && isAuthenticated(player)) {
                        player.sendMessage("[Market] Could not load marketplace listings. Try again shortly.");
                    }
                });
                return;
            }

            try {
                var json = com.google.gson.JsonParser.parseString(response.body()).getAsJsonObject();
                int curPage = json.has("page") ? json.get("page").getAsInt() : page;
                int totalPages = json.has("total_pages") ? json.get("total_pages").getAsInt() : 1;
                long buyerCoins = json.has("buyer_coins") ? json.get("buyer_coins").getAsLong() : 0L;
                var listingsArr = json.has("listings") ? json.get("listings").getAsJsonArray() : new com.google.gson.JsonArray();

                List<MarketListingEntry> entries = new ArrayList<>();
                for (var elem : listingsArr) {
                    var obj = elem.getAsJsonObject();
                    String id = obj.get("id").getAsString();
                    String seller = obj.get("seller").getAsString();
                    String sellerUuid = obj.get("seller_uuid").getAsString();
                    boolean isMine = obj.has("is_mine") && obj.get("is_mine").getAsBoolean();
                    int remaining = obj.get("remaining").getAsInt();
                    Long unitPrice = obj.has("unit_price") && !obj.get("unit_price").isJsonNull() ? obj.get("unit_price").getAsLong() : null;
                    Long lotPrice = obj.has("lot_price") && !obj.get("lot_price").isJsonNull() ? obj.get("lot_price").getAsLong() : null;
                    String itemBytes = obj.has("item_bytes") && !obj.get("item_bytes").isJsonNull() ? obj.get("item_bytes").getAsString() : null;

                    var itemObj = obj.has("item") && obj.get("item").isJsonObject() ? obj.get("item").getAsJsonObject() : null;
                    String itemKey = itemObj != null && itemObj.has("key") ? itemObj.get("key").getAsString() : "minecraft:chest";
                    String displayName = itemObj != null && itemObj.has("display_name") && !itemObj.get("display_name").isJsonNull()
                        ? itemObj.get("display_name").getAsString()
                        : null;

                    ItemStack raw = null;
                    if (itemBytes != null && !itemBytes.isEmpty()) {
                        try {
                            raw = ItemStack.deserializeBytes(java.util.Base64.getDecoder().decode(itemBytes));
                        } catch (Exception ignored) {}
                    }
                    if (raw == null || raw.isEmpty()) {
                        String matName = itemKey.startsWith("minecraft:") ? itemKey.substring("minecraft:".length()).toUpperCase(Locale.ROOT) : itemKey.toUpperCase(Locale.ROOT);
                        Material mat = Material.matchMaterial(matName);
                        if (mat == null) mat = Material.CHEST;
                        raw = new ItemStack(mat);
                    }
                    if (displayName == null) {
                        displayName = SellRules.formatItemName(null, raw.getType().name());
                    }

                    entries.add(new MarketListingEntry(id, seller, sellerUuid, isMine, remaining, unitPrice, lotPrice, displayName, raw));
                }

                getServer().getScheduler().runTask(this, () -> {
                    if (!player.isOnline() || !isAuthenticated(player)) return;

                    MarketHolder holder = new MarketHolder(curPage, totalPages, query, buyerCoins);
                    String title = MarketRules.formatInventoryTitle(curPage, totalPages, query);
                    Inventory inv = org.bukkit.Bukkit.createInventory(holder, 54, net.kyori.adventure.text.Component.text(title));
                    holder.setInventory(inv);

                    // Slots 0..44: listings
                    for (int i = 0; i < entries.size() && i < 45; i++) {
                        MarketListingEntry entry = entries.get(i);
                        ItemStack display = entry.rawItem().clone();
                        display.setAmount(Math.min(entry.remaining(), display.getMaxStackSize()));

                        ItemMeta meta = display.getItemMeta();
                        if (meta != null) {
                            List<net.kyori.adventure.text.Component> lore = new ArrayList<>();
                            if (meta.hasLore() && meta.lore() != null) {
                                lore.addAll(meta.lore());
                            }
                            lore.add(net.kyori.adventure.text.Component.text("§8----------------------------"));
                            lore.add(net.kyori.adventure.text.Component.text("§7Seller: §f" + entry.seller()));
                            lore.add(net.kyori.adventure.text.Component.text("§7Available: §e" + entry.remaining()));
                            if (entry.unitPrice() != null) {
                                lore.add(net.kyori.adventure.text.Component.text(String.format(Locale.ROOT, "§7Unit Price: §6%,d coins", entry.unitPrice())));
                            }
                            if (entry.lotPrice() != null) {
                                lore.add(net.kyori.adventure.text.Component.text(String.format(Locale.ROOT, "§7Lot Price: §6%,d coins", entry.lotPrice())));
                            }
                            lore.add(net.kyori.adventure.text.Component.text(""));
                            if (entry.isMine()) {
                                lore.add(net.kyori.adventure.text.Component.text("§b[Your Listing]"));
                                lore.add(net.kyori.adventure.text.Component.text("§cShift-Click to Cancel"));
                            } else {
                                lore.add(net.kyori.adventure.text.Component.text("§a§lClick to Purchase"));
                                if (entry.unitPrice() != null && entry.lotPrice() != null && entry.remaining() > 1) {
                                    lore.add(net.kyori.adventure.text.Component.text("§eLeft-Click: §fBuy 1 §7| §eRight-Click: §fBuy All"));
                                } else if (entry.lotPrice() != null && entry.remaining() > 1) {
                                    lore.add(net.kyori.adventure.text.Component.text("§eClick: §fBuy Whole Lot"));
                                } else {
                                    lore.add(net.kyori.adventure.text.Component.text("§eClick: §fBuy"));
                                }
                            }
                            lore.add(net.kyori.adventure.text.Component.text("§8----------------------------"));
                            meta.lore(lore);
                            display.setItemMeta(meta);
                        }

                        inv.setItem(i, display);
                        holder.putListing(i, entry);
                    }

                    // Bottom navigation row: slots 45..53
                    ItemStack pane = new ItemStack(Material.GRAY_STAINED_GLASS_PANE);
                    ItemMeta paneMeta = pane.getItemMeta();
                    if (paneMeta != null) {
                        paneMeta.displayName(net.kyori.adventure.text.Component.text(" "));
                        pane.setItemMeta(paneMeta);
                    }
                    for (int slot = 45; slot < 54; slot++) {
                        inv.setItem(slot, pane);
                    }

                    // Slot 45: Previous page
                    if (curPage > 1) {
                        ItemStack prev = new ItemStack(Material.ARROW);
                        ItemMeta prevMeta = prev.getItemMeta();
                        if (prevMeta != null) {
                            prevMeta.displayName(net.kyori.adventure.text.Component.text("§a◄ Previous Page"));
                            prevMeta.lore(List.of(net.kyori.adventure.text.Component.text("§7Go to page " + (curPage - 1))));
                            prev.setItemMeta(prevMeta);
                        }
                        inv.setItem(45, prev);
                    }

                    // Slot 48: Coins balance
                    ItemStack bal = new ItemStack(Material.SUNFLOWER);
                    ItemMeta balMeta = bal.getItemMeta();
                    if (balMeta != null) {
                        balMeta.displayName(net.kyori.adventure.text.Component.text("§6Your Balance"));
                        balMeta.lore(List.of(net.kyori.adventure.text.Component.text(String.format(Locale.ROOT, "§e%,d coins", buyerCoins))));
                        bal.setItemMeta(balMeta);
                    }
                    inv.setItem(48, bal);

                    // Slot 49: Market info & refresh
                    ItemStack info = new ItemStack(Material.COMPASS);
                    ItemMeta infoMeta = info.getItemMeta();
                    if (infoMeta != null) {
                        infoMeta.displayName(net.kyori.adventure.text.Component.text("§eMarketplace Info"));
                        List<net.kyori.adventure.text.Component> infoLore = new ArrayList<>();
                        infoLore.add(net.kyori.adventure.text.Component.text("§7Page: §f" + curPage + "§7/§f" + totalPages));
                        if (query != null && !query.isBlank()) {
                            infoLore.add(net.kyori.adventure.text.Component.text("§7Filter: §e\"" + query + "\""));
                            infoLore.add(net.kyori.adventure.text.Component.text("§cClick to clear search filter"));
                        } else {
                            infoLore.add(net.kyori.adventure.text.Component.text("§aClick to refresh listings"));
                        }
                        infoMeta.lore(infoLore);
                        info.setItemMeta(infoMeta);
                    }
                    inv.setItem(49, info);

                    // Slot 50: How to sell
                    ItemStack sellInfo = new ItemStack(Material.CHEST);
                    ItemMeta sellMeta = sellInfo.getItemMeta();
                    if (sellMeta != null) {
                        sellMeta.displayName(net.kyori.adventure.text.Component.text("§aHow to Sell Items"));
                        sellMeta.lore(List.of(
                            net.kyori.adventure.text.Component.text("§7Hold an item in hand and type:"),
                            net.kyori.adventure.text.Component.text("§e/sell <price> [stack price]")
                        ));
                        sellInfo.setItemMeta(sellMeta);
                    }
                    inv.setItem(50, sellInfo);

                    // Slot 53: Next page
                    if (curPage < totalPages) {
                        ItemStack next = new ItemStack(Material.ARROW);
                        ItemMeta nextMeta = next.getItemMeta();
                        if (nextMeta != null) {
                            nextMeta.displayName(net.kyori.adventure.text.Component.text("§aNext Page ►"));
                            nextMeta.lore(List.of(net.kyori.adventure.text.Component.text("§7Go to page " + (curPage + 1))));
                            next.setItemMeta(nextMeta);
                        }
                        inv.setItem(53, next);
                    }

                    player.openInventory(inv);
                });
            } catch (Exception e) {
                getLogger().warning("Error displaying marketplace inventory: " + e.getMessage());
            }
        });
    }

    private void cancelCommand(Player player, String listingId) {
        player.sendMessage("[Market] Cancelling listing...");
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            var body = new com.google.gson.JsonObject();
            body.addProperty("uuid", player.getUniqueId().toString());
            body.addProperty("listing_id", listingId);

            HttpResponse<String> response = post(marketplaceCancelUrl, body.toString(), requestTimeout);
            int code = response == null ? 500 : response.statusCode();

            getServer().getScheduler().runTask(this, () -> {
                if (!player.isOnline() || !isAuthenticated(player)) return;
                if (code == 200 || code == 202) {
                    player.sendMessage("[Market] Listing cancelled! Your items will be returned to your inventory.");
                    syncMarketplace();
                } else if (code == 404) {
                    player.sendMessage("[Market] Listing not found or not owned by you.");
                } else if (code == 429) {
                    player.sendMessage("[Market] You have reached the limit of 5 pending item deliveries. Please empty inventory space first.");
                } else {
                    player.sendMessage("[Market] Failed to cancel listing (" + code + ").");
                }
            });
        });
    }

    private void buyListingInGame(Player player, MarketListingEntry entry, String pricing, int quantity, long total) {
        UUID uuid = player.getUniqueId();
        player.closeInventory();
        player.sendMessage(String.format(Locale.ROOT, "[Market] Purchasing %dx %s for %,d coins...", quantity, entry.displayName(), total));

        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            var body = new com.google.gson.JsonObject();
            body.addProperty("buyer_uuid", uuid.toString());
            body.addProperty("listing_id", entry.id());
            body.addProperty("pricing", pricing);
            body.addProperty("quantity", quantity);
            body.addProperty("expected_total", total);
            body.addProperty("expected_remaining", entry.remaining());

            HttpResponse<String> response = post(marketplaceBuyUrl, body.toString(), requestTimeout);
            int code = response == null ? 500 : response.statusCode();

            getServer().getScheduler().runTask(this, () -> {
                if (!player.isOnline() || !isAuthenticated(player)) return;
                if (code == 200 || code == 202) {
                    player.sendMessage(String.format(Locale.ROOT, "[Market] Successfully purchased %dx %s for %,d coins!", quantity, entry.displayName(), total));
                    try {
                        player.playSound(player.getLocation(), org.bukkit.Sound.ENTITY_PLAYER_LEVELUP, 1.0f, 1.0f);
                    } catch (Exception ignored) {}
                    syncMarketplace();
                } else if (code == 404) {
                    player.sendMessage("[Market] That listing is no longer available.");
                } else if (code == 422) {
                    player.sendMessage("[Market] You do not have enough coins to purchase this item.");
                } else if (code == 429) {
                    player.sendMessage("[Market] You have 5 pending item deliveries. Please empty space in your inventory first.");
                } else if (code == 409) {
                    player.sendMessage("[Market] Marketplace conflict: the item was already sold or updated.");
                } else {
                    player.sendMessage("[Market] Purchase failed (" + code + ").");
                }
            });
        });
    }

    @EventHandler
    public void onMarketInventoryClick(InventoryClickEvent event) {
        if (!(event.getWhoClicked() instanceof Player player)) return;
        if (!(event.getInventory().getHolder() instanceof MarketHolder holder)) return;

        event.setCancelled(true);
        if (event.getClickedInventory() != event.getInventory()) return;

        int slot = event.getSlot();
        if (slot < 0 || slot >= 54) return;

        if (slot == 45 && holder.getPage() > 1) {
            openMarket(player, holder.getPage() - 1, holder.getQuery());
            return;
        }
        if (slot == 53 && holder.getPage() < holder.getTotalPages()) {
            openMarket(player, holder.getPage() + 1, holder.getQuery());
            return;
        }
        if (slot == 49) {
            if (holder.getQuery() != null && !holder.getQuery().isBlank()) {
                openMarket(player, 1, "");
            } else {
                openMarket(player, holder.getPage(), "");
            }
            return;
        }

        MarketListingEntry entry = holder.getListing(slot);
        if (entry == null) return;

        if (entry.isMine()) {
            if (event.isShiftClick()) {
                player.closeInventory();
                cancelCommand(player, entry.id());
            } else {
                player.sendMessage("[Market] This is your listing. Shift-click to cancel it and retrieve the items.");
            }
            return;
        }

        boolean buyLot = event.isRightClick() && entry.lotPrice() != null;
        int quantity = MarketRules.computePurchaseQuantity(buyLot, entry.unitPrice(), entry.lotPrice(), entry.remaining());
        long total;
        try {
            total = MarketRules.computePurchaseTotal(buyLot, entry.unitPrice(), entry.lotPrice(), quantity, entry.remaining());
        } catch (Exception e) {
            player.sendMessage("[Market] Invalid purchase pricing.");
            return;
        }

        String pricing = buyLot ? "lot" : (entry.unitPrice() != null ? "unit" : "lot");
        if (holder.getBuyerCoins() < total) {
            player.sendMessage(String.format(Locale.ROOT, "[Market] You need %,d coins but only have %,d.", total, holder.getBuyerCoins()));
            return;
        }

        buyListingInGame(player, entry, pricing, quantity, total);
    }

    @EventHandler
    public void onMarketInventoryDrag(InventoryDragEvent event) {
        if (event.getInventory().getHolder() instanceof MarketHolder) {
            event.setCancelled(true);
        }
    }

    @EventHandler
    public void onQuestInventoryClick(InventoryClickEvent event) {
        if (!(event.getWhoClicked() instanceof Player player)) return;
        if (!(event.getInventory().getHolder() instanceof QuestHolder holder)) return;

        event.setCancelled(true);
        if (event.getClickedInventory() != event.getInventory()) return;

        int slot = event.getSlot();
        if (slot < 0 || slot >= 45) return;

        var overview = holder.getOverview();
        if (overview == null) return;

        boolean starterCompleted = overview.has("starter_completed") && overview.get("starter_completed").getAsBoolean();
        int starterStep = overview.has("starter_step") ? overview.get("starter_step").getAsInt() : (starterCompleted ? 5 : 1);
        int completedToday = overview.has("daily_completed_today") ? overview.get("daily_completed_today").getAsInt() : 0;
        int dailyLimit = overview.has("daily_limit") ? overview.get("daily_limit").getAsInt() : 2;

        if (slot == 42) {
            player.closeInventory();
            player.playSound(player.getLocation(), Sound.BLOCK_CHEST_CLOSE, 0.8f, 1.0f);
            return;
        }

        if (slot == 38) {
            player.playSound(player.getLocation(), Sound.UI_BUTTON_CLICK, 0.8f, 1.2f);
            openQuestsGui(player);
            return;
        }

        if (slot == 10 || slot == 12 || slot == 14 || slot == 16) {
            int stageClicked = switch (slot) {
                case 10 -> 1;
                case 12 -> 2;
                case 14 -> 3;
                case 16 -> 4;
                default -> 1;
            };
            String kind = switch (slot) {
                case 10 -> "starter_wood";
                case 12 -> "starter_bed";
                case 14 -> "starter_iron";
                case 16 -> "starter_private";
                default -> "starter_wood";
            };

            if (starterCompleted || starterStep > stageClicked) {
                player.playSound(player.getLocation(), Sound.ENTITY_VILLAGER_YES, 0.8f, 1.0f);
                player.sendMessage("[Quests] You have already completed Stage " + stageClicked + "!");
                return;
            }
            if (starterStep == stageClicked) {
                var active = overview.has("active_contract") && !overview.get("active_contract").isJsonNull()
                    ? overview.getAsJsonObject("active_contract") : null;
                if (active != null && kind.equals(active.get("kind").getAsString()) && "active".equals(active.get("status").getAsString())) {
                    player.playSound(player.getLocation(), Sound.UI_BUTTON_CLICK, 0.8f, 1.0f);
                    player.sendMessage("[Quests] This quest is already active! Track it with the compass below.");
                    return;
                }
                player.closeInventory();
                startContractFromGui(player, kind);
                return;
            }
            if (starterStep < stageClicked) {
                player.playSound(player.getLocation(), Sound.ENTITY_VILLAGER_NO, 1.0f, 0.8f);
                player.sendMessage("[Quests] §cLocked! Complete Stage " + starterStep + " first.");
                return;
            }
            return;
        }

        if (slot == 19 || slot == 21 || slot == 23 || slot == 25) {
            if (!starterCompleted) {
                player.playSound(player.getLocation(), Sound.ENTITY_VILLAGER_NO, 1.0f, 0.8f);
                player.sendMessage("[Quests] §cLocked! Complete all 4 Starter Stages to unlock Daily Contracts.");
                return;
            }
            if (completedToday >= dailyLimit) {
                player.playSound(player.getLocation(), Sound.ENTITY_VILLAGER_NO, 1.0f, 0.8f);
                player.sendMessage("[Quests] §cDaily limit reached: two contracts per UTC day.");
                return;
            }
            String kind = switch (slot) {
                case 19 -> "hunting";
                case 21 -> "fishing";
                case 23 -> "farming";
                case 25 -> "mining";
                default -> "hunting";
            };
            player.closeInventory();
            startContractFromGui(player, kind);
        }
    }

    @EventHandler
    public void onQuestInventoryDrag(InventoryDragEvent event) {
        if (event.getInventory().getHolder() instanceof QuestHolder) {
            event.setCancelled(true);
        }
    }

    // --- Dynamic Chest GUI Holders -------------------------------------------

    public static final class PsMenuHolder implements InventoryHolder {
        private final com.google.gson.JsonArray blocks;
        private final long coinBalance;
        private Inventory inventory;

        public PsMenuHolder(com.google.gson.JsonArray blocks, long coinBalance) {
            this.blocks = blocks;
            this.coinBalance = coinBalance;
        }

        public com.google.gson.JsonArray getBlocks() { return blocks; }
        public long getCoinBalance() { return coinBalance; }
        public void setInventory(Inventory inventory) { this.inventory = inventory; }
        @Override public Inventory getInventory() { return inventory; }
    }

    public static final class MinerShopHolder implements InventoryHolder {
        private final long coinBalance;
        private Inventory inventory;

        public MinerShopHolder(long coinBalance) {
            this.coinBalance = coinBalance;
        }

        public long getCoinBalance() { return coinBalance; }
        public void setInventory(Inventory inventory) { this.inventory = inventory; }
        @Override public Inventory getInventory() { return inventory; }
    }

    public static final class RaidShopHolder implements InventoryHolder {
        private final long coinBalance;
        private Inventory inventory;

        public RaidShopHolder(long coinBalance) {
            this.coinBalance = coinBalance;
        }

        public long getCoinBalance() { return coinBalance; }
        public void setInventory(Inventory inventory) { this.inventory = inventory; }
        @Override public Inventory getInventory() { return inventory; }
    }

    public static final class MailboxHolder implements InventoryHolder {
        private final com.google.gson.JsonArray pendingList;
        private Inventory inventory;

        public MailboxHolder(com.google.gson.JsonArray pendingList) {
            this.pendingList = pendingList;
        }

        public com.google.gson.JsonArray getPendingList() { return pendingList; }
        public void setInventory(Inventory inventory) { this.inventory = inventory; }
        @Override public Inventory getInventory() { return inventory; }
    }

    @EventHandler
    public void onDynamicGuiClick(InventoryClickEvent event) {
        if (!(event.getWhoClicked() instanceof Player player)) return;
        InventoryHolder holder = event.getInventory().getHolder();

        if (holder instanceof PsMenuHolder psHolder) {
            event.setCancelled(true);
            if (event.getClickedInventory() != event.getInventory()) return;
            handlePsMenuClick(player, psHolder, event.getSlot());
            return;
        }
        if (holder instanceof MinerShopHolder shopHolder) {
            event.setCancelled(true);
            if (event.getClickedInventory() != event.getInventory()) return;
            handleMinerShopClick(player, shopHolder, event.getSlot());
            return;
        }
        if (holder instanceof RaidShopHolder raidHolder) {
            event.setCancelled(true);
            if (event.getClickedInventory() != event.getInventory()) return;
            handleRaidShopClick(player, raidHolder, event.getSlot());
            return;
        }
        if (holder instanceof MailboxHolder mailHolder) {
            event.setCancelled(true);
            if (event.getClickedInventory() != event.getInventory()) return;
            handleMailboxClick(player, mailHolder, event.getSlot());
            return;
        }
    }

    @EventHandler
    public void onDynamicGuiDrag(InventoryDragEvent event) {
        InventoryHolder holder = event.getInventory().getHolder();
        if (holder instanceof PsMenuHolder || holder instanceof MinerShopHolder
                || holder instanceof RaidShopHolder || holder instanceof MailboxHolder) {
            event.setCancelled(true);
        }
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
        checkPendingMail(event.getPlayer());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onRegister(RegisterEvent event) {
        countLogin(event.getPlayer());
        announce(event.getPlayer());
        checkPendingMail(event.getPlayer());
    }

    /**
     * One authenticated session. Registering counts too: the player is now in the
     * world under the identity the panel will be told about.
     */
    private void countLogin(Player player) {
        if (player != null && isAuthenticated(player)) {
            addCapped(countersFor(player).logins, 1);
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
        long seconds,kills,fish,crops,mined,smelted,wood,beds,privates;
        long[] snapshot(){return new long[]{Math.min(86400,seconds),Math.min(10000,kills),Math.min(10000,fish),Math.min(10000,crops),Math.min(10000,mined),Math.min(10000,smelted),Math.min(10000,wood),Math.min(10000,beds),Math.min(10000,privates)};}
        void subtract(long[] accepted){seconds-=accepted[0];kills-=accepted[1];fish-=accepted[2];crops-=accepted[3];mined-=accepted[4];smelted-=accepted[5];wood-=accepted[6];beds-=accepted[7];privates-=accepted[8];}
        boolean empty(){return seconds==0&&kills==0&&fish==0&&crops==0&&mined==0&&smelted==0&&wood==0&&beds==0&&privates==0;}
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
    private String internalBase;
    private final Map<String, PlacedPrivateBlock> placedPrivateBlocks = new ConcurrentHashMap<>();
    private final Map<UUID, Long> activeMineExpeditions = new ConcurrentHashMap<>();
    private final Map<UUID, Location> mineReturnLocations = new ConcurrentHashMap<>();
    private final Map<UUID, net.kyori.adventure.bossbar.BossBar> expeditionBossBars = new ConcurrentHashMap<>();
    private final Map<Location, RegeneratingOreNode> regeneratingNodes = new ConcurrentHashMap<>();
    private final Map<UUID, PlacedPrivateBlock> activeCoreGuis = new ConcurrentHashMap<>();
    private final Map<String, ActiveBreach> activeBreaches = new ConcurrentHashMap<>();
    private final List<PrimedCharge> primedCharges = new CopyOnWriteArrayList<>();
    private NamespacedKey creeperTriggerKey;
    private NamespacedKey raidTntKey;
    private NamespacedKey breachZoneKey;
    private final Map<String, String> activeRaidTntBlocks = new ConcurrentHashMap<>();
    private final Map<UUID, org.bukkit.scheduler.BukkitTask> activeTeleportWarmups = new ConcurrentHashMap<>();
    private final Map<UUID, Long> teleportCooldowns = new ConcurrentHashMap<>();
    private final Map<UUID, Long> lastCombatMillis = new ConcurrentHashMap<>();

    private static final class RegeneratingOreNode {
        final Material originalMaterial;
        final long regenAtMs;
        RegeneratingOreNode(Material originalMaterial, long regenAtMs) {
            this.originalMaterial = originalMaterial;
            this.regenAtMs = regenAtMs;
        }
    }

    private void initializeEconomy() {
        internalBase = statsUrl.substring(0, statsUrl.length()-"/internal/stats/report".length()) + "/internal";
        economyBase = internalBase + "/economy";
        economyOutbox = getDataFolder().toPath().resolve("pending-economy.json");
        try { if (Files.exists(economyOutbox)) economyPending = Files.readString(economyOutbox); }
        catch (IOException error) { throw new IllegalStateException("Cannot recover economy outbox", error); }
        if (getCommand("quests") != null) {
            getCommand("quests").setExecutor(this);
            getCommand("quests").setTabCompleter((sender,command,alias,args) -> {
                if (!(sender instanceof Player player) || !isAuthenticated(player)) return List.of();
                if(args.length==2 && args[0].equalsIgnoreCase("start"))return List.of("hunting","fishing","farming","mining").stream().filter(v->v.startsWith(args[1].toLowerCase(Locale.ROOT))).toList();
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
            switch(counter) {
                case 2 -> count.fish+=amount;
                case 3 -> count.crops+=amount;
                case 4 -> count.mined+=amount;
                case 5 -> count.smelted+=amount;
                case 6 -> count.wood+=amount;
                case 7 -> count.beds+=amount;
                case 8 -> count.privates+=amount;
                default -> throw new IllegalArgumentException("Unknown objective");
            }
        }
    }
    private boolean ironOre(org.bukkit.block.Block block) {
        return block.getType()==org.bukkit.Material.IRON_ORE||block.getType()==org.bukkit.Material.DEEPSLATE_IRON_ORE;
    }
    private boolean isMiningOre(org.bukkit.block.Block block) {
        String name = block.getType().name();
        return name.endsWith("_ORE") || name.equals("ANCIENT_DEBRIS");
    }
    private boolean isLog(org.bukkit.block.Block block) {
        String name = block.getType().name();
        return name.endsWith("_LOG") || name.endsWith("_WOOD") || name.endsWith("_STEM") || name.endsWith("_HYPHAE");
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
    private boolean placedLog(org.bukkit.block.Block block,boolean add,boolean remove) {
        var key=new NamespacedKey(this,"quest_placed_log");var data=block.getChunk().getPersistentDataContainer();
        long[] saved=data.getOrDefault(key,org.bukkit.persistence.PersistentDataType.LONG_ARRAY,new long[0]);
        var positions=new java.util.HashSet<Long>();for(long position:saved)positions.add(position);
        boolean exists=positions.contains(orePosition(block));
        if(add)positions.add(orePosition(block));if(remove)positions.remove(orePosition(block));
        if(add||remove) {if(positions.isEmpty())data.remove(key);else data.set(key,org.bukkit.persistence.PersistentDataType.LONG_ARRAY,positions.stream().mapToLong(Long::longValue).toArray());}
        return exists;
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void onQuestOrePlace(BlockPlaceEvent event) {
        if(isMiningOre(event.getBlockPlaced()))placedOre(event.getBlockPlaced(),true,false);
        if(isLog(event.getBlockPlaced()))placedLog(event.getBlockPlaced(),true,false);
        if(event.getBlockPlaced().getType().name().endsWith("_BED"))questProgress(event.getPlayer(),"starter_bed",7,1);
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void onQuestBedEnter(org.bukkit.event.player.PlayerBedEnterEvent event) {
        if(event.getBedEnterResult()==org.bukkit.event.player.PlayerBedEnterEvent.BedEnterResult.OK) {
            Player player=event.getPlayer();
            if(isAuthenticated(player)) {
                lastActive.put(player.getUniqueId(),System.currentTimeMillis());
                questProgress(player,"starter_bed",7,1);
            }
        }
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void onQuestPiston(org.bukkit.event.block.BlockPistonExtendEvent event) {
        for(var block:event.getBlocks()) {
            if(isMiningOre(block))placedOre(block.getRelative(event.getDirection()),true,false);
            if(isLog(block))placedLog(block.getRelative(event.getDirection()),true,false);
        }
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void onQuestPistonRetract(org.bukkit.event.block.BlockPistonRetractEvent event) {
        for(var block:event.getBlocks()) {
            if(isMiningOre(block))placedOre(block.getRelative(event.getDirection()),true,false);
            if(isLog(block))placedLog(block.getRelative(event.getDirection()),true,false);
        }
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void onQuestHarvest(BlockBreakEvent event) {
        Player player=event.getPlayer();var block=event.getBlock();
        boolean ore = isMiningOre(block);
        boolean placed = ore && placedOre(block,false,true);
        if(!isAuthenticated(player)||player.getGameMode()!=org.bukkit.GameMode.SURVIVAL||!event.isDropItems())return;
        if(ironOre(block)&&!placed&&block.getDrops(player.getInventory().getItemInMainHand(),player).stream().anyMatch(item->item.getType()==org.bukkit.Material.RAW_IRON))questProgress(player,"starter_iron",4,1);
        if(ore && !placed) questProgress(player,"mining",4,1);
        if(isLog(block)&&!placedLog(block,false,true)) questProgress(player,"starter_wood",6,1);
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
                        long seconds=captured[0],kills=captured[1],fish=captured[2],crops=captured[3],mined=captured[4],smelted=captured[5],wood=captured[6],beds=captured[7],privates=captured[8];
                        var day=new com.google.gson.JsonObject(); day.addProperty("day",key.day()); day.addProperty("active_seconds",seconds); day.addProperty("kills",kills);
                        if (!key.contract().isEmpty()) day.addProperty("contract_id",key.contract());
                        day.addProperty("fish_caught",fish);day.addProperty("crops_harvested",crops);day.addProperty("iron_mined",mined);day.addProperty("iron_smelted",smelted);
                        if(wood>0) day.addProperty("wood_collected",wood);
                        if(beds>0) day.addProperty("bed_used",beds);
                        if(privates>0) day.addProperty("private_placed",privates);
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
                else if(response.statusCode()==429) message="[Quests] Daily limit reached: two contracts per UTC day.";
                else if(response.statusCode()==402) message="[Quests] No funded coin reward is available. Coin shares renew at UTC midnight after observed activity; your existing coins are unchanged.";
                else if(response.statusCode()!=200) message="[Quests] Cannot load your contract. Try again.";
                else {
                    try {
                        var json=com.google.gson.JsonParser.parseString(response.body());
                        if(json.isJsonNull()) {contracts.remove(uuid);message="[Quests] Use /quests to open the Quests Board and begin your Starter Journey.";}
                        else {
                            var contract=json.getAsJsonObject(); contracts.put(uuid,contract);
                            String objective=contract.has("kind")?contract.get("kind").getAsString():"hunting";
                            int progress=contract.get("progress").getAsInt(),target=contract.get("target").getAsInt();
                            String goal=switch(objective) {
                                case "starter_wood" -> "Gather wood logs: "+progress+"/"+target;
                                case "starter_bed" -> "Place or sleep in a bed: "+progress+"/"+target;
                                case "starter_iron" -> "Mine iron ore: "+progress+"/"+target+"; smelt/extract iron ingots: "+contract.get("secondary_progress").getAsInt()+"/"+target;
                                case "starter_private" -> "Place private territory protection core (/ps buy): "+progress+"/"+target;
                                case "fishing" -> "Catch fish with a rod: "+progress+"/"+target;
                                case "farming" -> "Harvest mature wheat, carrots, potatoes or beetroot: "+progress+"/"+target;
                                case "mining" -> "Mine natural underground ores: "+progress+"/"+target;
                                default -> "Natural hostile mobs: "+progress+"/"+target;
                            };
                            String legacy="";
                            if(contract.has("iron") && (contract.get("iron").getAsInt()>0||contract.get("bread").getAsInt()>0||contract.get("xp").getAsInt()>0))legacy="; existing promised items: "+contract.get("iron")+" iron, "+contract.get("bread")+" bread, "+contract.get("xp")+" XP";
                            message="[Quests] "+(contract.get("status").getAsString().equals("paid")?"completed":contract.get("status").getAsString())+": "+goal+". Reward: "+contract.get("reward").getAsLong()+" coins"+legacy+". Two contracts per UTC day; 24-hour expiry. Use /quests (visual GUI) or /quests start [hunting|fishing|farming|mining].";
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

    static final class QuestHolder implements org.bukkit.inventory.InventoryHolder {
        private final org.bukkit.inventory.Inventory inventory;
        private final com.google.gson.JsonObject overview;
        QuestHolder(int size, String title, com.google.gson.JsonObject overview) {
            this.inventory = org.bukkit.Bukkit.createInventory(this, size, net.kyori.adventure.text.Component.text(title));
            this.overview = overview;
        }
        @Override public org.bukkit.inventory.Inventory getInventory() { return inventory; }
        com.google.gson.JsonObject getOverview() { return overview; }
    }

    static String formatQuestProgressBar(int current, int max, int barLength) {
        if (max <= 0) return "§8[§a" + "█".repeat(barLength) + "§8]";
        int filled = Math.min(barLength, Math.max(0, (int) Math.round(((double) current / max) * barLength)));
        int empty = barLength - filled;
        return "§8[§a" + "█".repeat(filled) + "§7" + "░".repeat(empty) + "§8]";
    }

    static String formatQuestExpiry(long expirySeconds) {
        long remaining = Math.max(0, expirySeconds - (System.currentTimeMillis() / 1000));
        long hours = remaining / 3600;
        long minutes = (remaining % 3600) / 60;
        return hours + "h " + minutes + "m";
    }

    private void openQuestsGui(Player player) {
        UUID uuid = player.getUniqueId();
        String username = player.getName();
        player.sendMessage("[Quests] Loading quest board...");
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            flushEconomy(requestTimeout);
            String url = internalBase + "/economy/quests/overview";
            var body = new com.google.gson.JsonObject();
            body.addProperty("uuid", uuid.toString());
            body.addProperty("username", username);
            var response = post(url, body.toString(), requestTimeout);
            if (response == null || response.statusCode() != 200) {
                getServer().getScheduler().runTask(this, () -> {
                    if (player.isOnline() && isAuthenticated(player)) {
                        player.sendMessage("[Quests] The quest board is unavailable. Please try again.");
                    }
                });
                return;
            }
            try {
                var overview = com.google.gson.JsonParser.parseString(response.body()).getAsJsonObject();
                getServer().getScheduler().runTask(this, () -> {
                    if (!player.isOnline() || !isAuthenticated(player)) return;
                    buildAndOpenQuestsInventory(player, overview);
                });
            } catch (Exception ex) {
                getLogger().warning("Failed to parse quests overview: " + ex);
            }
        });
    }

    private void startContractFromGui(Player player, String kind) {
        UUID uuid = player.getUniqueId();
        String username = player.getName();
        player.sendMessage("[Quests] Starting contract: " + kind + "...");
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            flushEconomy(requestTimeout);
            var body = new com.google.gson.JsonObject();
            body.addProperty("uuid", uuid.toString());
            body.addProperty("username", username);
            body.addProperty("start", true);
            body.addProperty("kind", kind);
            var response = post(economyBase + "/contract", body.toString(), requestTimeout);
            getServer().getScheduler().runTask(this, () -> {
                if (!player.isOnline() || !isAuthenticated(player)) return;
                if (response == null) {
                    player.sendMessage("[Quests] The panel is unavailable. Try again.");
                    player.playSound(player.getLocation(), Sound.ENTITY_VILLAGER_NO, 1.0f, 1.0f);
                } else if (response.statusCode() == 429) {
                    player.sendMessage("[Quests] Daily limit reached: two contracts per UTC day.");
                    player.playSound(player.getLocation(), Sound.ENTITY_VILLAGER_NO, 1.0f, 1.0f);
                } else if (response.statusCode() == 402) {
                    player.sendMessage("[Quests] No funded coin reward is available. Coin shares renew at UTC midnight.");
                    player.playSound(player.getLocation(), Sound.ENTITY_VILLAGER_NO, 1.0f, 1.0f);
                } else if (response.statusCode() != 200) {
                    player.sendMessage("[Quests] Cannot start this contract. Try again.");
                    player.playSound(player.getLocation(), Sound.ENTITY_VILLAGER_NO, 1.0f, 1.0f);
                } else {
                    try {
                        var json = com.google.gson.JsonParser.parseString(response.body()).getAsJsonObject();
                        contracts.put(uuid, json);
                        String startedKind = json.has("kind") ? json.get("kind").getAsString() : kind;
                        int target = json.get("target").getAsInt();
                        long reward = json.get("reward").getAsLong();
                        player.playSound(player.getLocation(), Sound.UI_TOAST_CHALLENGE_COMPLETE, 0.9f, 1.2f);
                        player.playSound(player.getLocation(), Sound.ENTITY_PLAYER_LEVELUP, 0.7f, 1.4f);
                        String kindName = switch (startedKind) {
                            case "starter_wood" -> "Starter: Wood Gathering";
                            case "starter_bed" -> "Starter: A Safe Night";
                            case "starter_iron" -> "Starter: The Iron Forge";
                            case "starter_private" -> "Starter: Claim Territory";
                            case "hunting" -> "Hunting";
                            case "fishing" -> "Fishing";
                            case "farming" -> "Farming";
                            case "mining" -> "Mining";
                            default -> startedKind;
                        };
                        player.sendMessage("§8[§6Quests§8] §aAccepted §f" + kindName + " §aContract! §7Target: §e" + target + " §7| Reward: §6" + reward + " coins");
                        openQuestsGui(player);
                    } catch (Exception ex) {
                        player.sendMessage("[Quests] Contract started!");
                    }
                }
            });
        });
    }

    private void buildAndOpenQuestsInventory(Player player, com.google.gson.JsonObject overview) {
        QuestHolder holder = new QuestHolder(45, "§8Quests & Contracts Board", overview);
        org.bukkit.inventory.Inventory inv = holder.getInventory();

        boolean starterCompleted = overview.has("starter_completed") && overview.get("starter_completed").getAsBoolean();
        int starterStep = overview.has("starter_step") ? overview.get("starter_step").getAsInt() : (starterCompleted ? 5 : 1);
        int completedToday = overview.has("daily_completed_today") ? overview.get("daily_completed_today").getAsInt() : 0;
        int dailyLimit = overview.has("daily_limit") ? overview.get("daily_limit").getAsInt() : 2;
        long coins = overview.has("coins") ? overview.get("coins").getAsLong() : 0;
        long reward = overview.has("reward") ? overview.get("reward").getAsLong() : 0;
        long baseReward = overview.has("base_reward") ? overview.get("base_reward").getAsLong() : reward;
        int huntingTarget = overview.has("hunting_target") ? overview.get("hunting_target").getAsInt() : 10;
        int fishingTarget = overview.has("fishing_target") ? overview.get("fishing_target").getAsInt() : 5;
        int farmingTarget = overview.has("farming_target") ? overview.get("farming_target").getAsInt() : 16;
        int miningTarget = overview.has("mining_target") ? overview.get("mining_target").getAsInt() : 12;

        com.google.gson.JsonObject active = overview.has("active_contract") && !overview.get("active_contract").isJsonNull()
            ? overview.getAsJsonObject("active_contract") : null;
        if (active != null) {
            contracts.put(player.getUniqueId(), active);
        } else {
            contracts.remove(player.getUniqueId());
        }

        ItemStack border = new ItemStack(Material.GRAY_STAINED_GLASS_PANE);
        ItemMeta bm = border.getItemMeta();
        if (bm != null) {
            bm.displayName(net.kyori.adventure.text.Component.text("§7 "));
            border.setItemMeta(bm);
        }
        for (int i = 0; i < 45; i++) {
            inv.setItem(i, border.clone());
        }

        // Slot 4: Player Stats
        ItemStack stats = new ItemStack(Material.NETHER_STAR);
        ItemMeta sm = stats.getItemMeta();
        if (sm != null) {
            sm.displayName(net.kyori.adventure.text.Component.text("§e§l📜 Quests & Economy Status"));
            List<net.kyori.adventure.text.Component> lore = new ArrayList<>();
            lore.add(net.kyori.adventure.text.Component.text("§7Player: §f" + player.getName()));
            lore.add(net.kyori.adventure.text.Component.text(String.format(Locale.ROOT, "§7Coin Balance: §6%,d coins", coins)));
            lore.add(net.kyori.adventure.text.Component.text("§7Starter Journey: " + (starterCompleted ? "§a✔ Completed" : "§e⭐ Stage " + starterStep + " of 4")));
            lore.add(net.kyori.adventure.text.Component.text("§7Daily Contracts Completed: §b" + completedToday + "/" + dailyLimit + " §7Today"));
            lore.add(net.kyori.adventure.text.Component.text("§7Funded Daily Reward: §6" + reward + " coins" + (reward < baseReward ? " §8(Base: " + baseReward + ")" : "")));
            lore.add(net.kyori.adventure.text.Component.text("§8--------------------------------"));
            if (active != null && "active".equals(active.get("status").getAsString())) {
                String activeKind = active.get("kind").getAsString();
                lore.add(net.kyori.adventure.text.Component.text("§a▶ Active Quest: §e" + activeKind));
            } else {
                lore.add(net.kyori.adventure.text.Component.text("§eClick an available contract to begin!"));
            }
            sm.lore(lore);
            stats.setItemMeta(sm);
        }
        inv.setItem(4, stats);

        // Row 1: The 4 Starter Stages
        inv.setItem(10, createStarterStageItem(1, "starter_wood", "Wood Gathering", "Gather 16 wood logs from trees", 16, 50, Material.OAK_LOG, active, starterStep, starterCompleted));
        inv.setItem(11, createStageArrowItem(2));
        inv.setItem(12, createStarterStageItem(2, "starter_bed", "A Safe Night", "Craft and place or sleep in a bed", 1, 50, Material.RED_BED, active, starterStep, starterCompleted));
        inv.setItem(13, createStageArrowItem(3));
        inv.setItem(14, createStarterStageItem(3, "starter_iron", "The Iron Forge", "Mine 10 raw iron & smelt 10 iron ingots", 10, 100, Material.BLAST_FURNACE, active, starterStep, starterCompleted));
        inv.setItem(15, createStageArrowItem(4));
        inv.setItem(16, createStarterStageItem(4, "starter_private", "Claim Territory", "Place a private territory core (/ps buy)", 1, 150, Material.LODESTONE, active, starterStep, starterCompleted));

        // Row 2: Daily Contracts Board (Slots 19, 21, 23, 25)
        if (!starterCompleted) {
            inv.setItem(19, createLockedContractItem("Hunting", huntingTarget, reward, Material.DIAMOND_SWORD));
            inv.setItem(21, createLockedContractItem("Fishing", fishingTarget, reward, Material.FISHING_ROD));
            inv.setItem(23, createLockedContractItem("Farming", farmingTarget, reward, Material.GOLDEN_HOE));
            inv.setItem(25, createLockedContractItem("Mining", miningTarget, reward, Material.DIAMOND_PICKAXE));
        } else {
            inv.setItem(19, createDailyContractItem("hunting", "🏹 Hunting Contract", "Track down and slay natural hostile monsters.", huntingTarget, reward, Material.DIAMOND_SWORD, active, completedToday >= dailyLimit));
            inv.setItem(21, createDailyContractItem("fishing", "🎣 Fishing Contract", "Cast your line and catch fish from rivers and seas.", fishingTarget, reward, Material.FISHING_ROD, active, completedToday >= dailyLimit));
            inv.setItem(23, createDailyContractItem("farming", "🌾 Farming Contract", "Harvest mature wheat, carrots, potatoes, or beetroots.", farmingTarget, reward, Material.GOLDEN_HOE, active, completedToday >= dailyLimit));
            inv.setItem(25, createDailyContractItem("mining", "⛏ Mining Contract", "Delve deep underground and mine natural ores.", miningTarget, reward, Material.DIAMOND_PICKAXE, active, completedToday >= dailyLimit));
        }

        // Slot 31: Active Tracker Compass
        ItemStack tracker = new ItemStack(Material.COMPASS);
        ItemMeta tm = tracker.getItemMeta();
        if (tm != null) {
            if (active != null && "active".equals(active.get("status").getAsString())) {
                String activeKind = active.get("kind").getAsString();
                int prog = active.get("progress").getAsInt();
                int tgt = active.get("target").getAsInt();
                tm.displayName(net.kyori.adventure.text.Component.text("§e§l🧭 Active Objective Tracker"));
                List<net.kyori.adventure.text.Component> tlore = new ArrayList<>();
                tlore.add(net.kyori.adventure.text.Component.text("§7Objective: §f" + activeKind.toUpperCase(Locale.ROOT)));
                if ("starter_iron".equals(activeKind)) {
                    int mined = prog;
                    int smelted = active.get("secondary_progress").getAsInt();
                    tlore.add(net.kyori.adventure.text.Component.text("§f • Mine Iron Ore: §e" + mined + "/" + tgt));
                    tlore.add(net.kyori.adventure.text.Component.text("§f • Smelt Iron Ingots: §e" + smelted + "/" + tgt));
                    int total = mined + smelted;
                    int max = tgt * 2;
                    int pct = max > 0 ? (int) Math.round(((double) total / max) * 100) : 0;
                    tlore.add(net.kyori.adventure.text.Component.text("§7Progress: §e" + total + "/" + max + " (" + pct + "%)"));
                    tlore.add(net.kyori.adventure.text.Component.text("§7Bar: " + formatQuestProgressBar(total, max, 14)));
                } else {
                    int pct = tgt > 0 ? (int) Math.round(((double) prog / tgt) * 100) : 0;
                    tlore.add(net.kyori.adventure.text.Component.text("§7Progress: §e" + prog + "/" + tgt + " (" + pct + "%)"));
                    tlore.add(net.kyori.adventure.text.Component.text("§7Bar: " + formatQuestProgressBar(prog, tgt, 14)));
                }
                if (active.has("expires")) {
                    tlore.add(net.kyori.adventure.text.Component.text("§7Time Remaining: §e" + formatQuestExpiry(active.get("expires").getAsLong())));
                }
                tm.lore(tlore);
                tm.addEnchant(Enchantment.LURE, 1, true);
                tm.addItemFlags(ItemFlag.HIDE_ENCHANTS);
            } else {
                tm.displayName(net.kyori.adventure.text.Component.text("§7🧭 Objective Tracker"));
                tm.lore(List.of(
                    net.kyori.adventure.text.Component.text("§7No active quest selected."),
                    net.kyori.adventure.text.Component.text("§eClick any available quest above to start.")
                ));
            }
            tracker.setItemMeta(tm);
        }
        inv.setItem(31, tracker);

        // Slot 38: Refresh
        ItemStack refresh = new ItemStack(Material.CLOCK);
        ItemMeta rm = refresh.getItemMeta();
        if (rm != null) {
            rm.displayName(net.kyori.adventure.text.Component.text("§e§l⏱ Refresh Quests"));
            rm.lore(List.of(
                net.kyori.adventure.text.Component.text("§7Click to update live quest progress"),
                net.kyori.adventure.text.Component.text("§7and synchronize counters with the server.")
            ));
            refresh.setItemMeta(rm);
        }
        inv.setItem(38, refresh);

        // Slot 40: Quest Guidelines
        ItemStack book = new ItemStack(Material.BOOK);
        ItemMeta bom = book.getItemMeta();
        if (bom != null) {
            bom.displayName(net.kyori.adventure.text.Component.text("§6§l⭐ Quest Guidelines"));
            bom.lore(List.of(
                net.kyori.adventure.text.Component.text("§7• 2 Daily Contracts allowed per UTC day."),
                net.kyori.adventure.text.Component.text("§7• Complete the 4 Starter Stages to unlock Daily Board."),
                net.kyori.adventure.text.Component.text("§7• Stage 1: Gather 16 wood logs."),
                net.kyori.adventure.text.Component.text("§7• Stage 2: Place or sleep in a bed."),
                net.kyori.adventure.text.Component.text("§7• Stage 3: Mine 10 iron & smelt 10 ingots."),
                net.kyori.adventure.text.Component.text("§7• Stage 4: Place territory core (/ps buy)."),
                net.kyori.adventure.text.Component.text("§7• Contracts expire after 24 hours."),
                net.kyori.adventure.text.Component.text("§7• Hostile monsters, ores, and logs must be natural.")
            ));
            book.setItemMeta(bom);
        }
        inv.setItem(40, book);

        // Slot 42: Close
        ItemStack close = new ItemStack(Material.BARRIER);
        ItemMeta cm = close.getItemMeta();
        if (cm != null) {
            cm.displayName(net.kyori.adventure.text.Component.text("§c§lClose Menu"));
            cm.lore(List.of(net.kyori.adventure.text.Component.text("§7Click to exit the quest board.")));
            close.setItemMeta(cm);
        }
        inv.setItem(42, close);

        player.openInventory(inv);
        player.playSound(player.getLocation(), Sound.BLOCK_CHEST_OPEN, 0.8f, 1.2f);
    }

    private ItemStack createStageArrowItem(int nextStage) {
        ItemStack item = new ItemStack(Material.ORANGE_STAINED_GLASS_PANE);
        ItemMeta meta = item.getItemMeta();
        if (meta != null) {
            meta.displayName(net.kyori.adventure.text.Component.text("§6➔ §eStage " + nextStage));
            item.setItemMeta(meta);
        }
        return item;
    }

    private ItemStack createStarterStageItem(int stage, String kind, String title, String desc, int target, long stageReward, Material icon, com.google.gson.JsonObject active, int currentStep, boolean allCompleted) {
        boolean isDone = allCompleted || currentStep > stage;
        boolean isCurrent = !allCompleted && currentStep == stage;
        boolean isActive = active != null && kind.equals(active.get("kind").getAsString()) && "active".equals(active.get("status").getAsString());

        ItemStack item = new ItemStack(icon);
        ItemMeta meta = item.getItemMeta();
        if (meta == null) return item;

        List<net.kyori.adventure.text.Component> lore = new ArrayList<>();
        lore.add(net.kyori.adventure.text.Component.text("§7Stage " + stage + ": " + desc));
        lore.add(net.kyori.adventure.text.Component.text("§8--------------------------------"));

        if (isDone) {
            meta.displayName(net.kyori.adventure.text.Component.text("§a§l✔ Stage " + stage + ": " + title + " §2[DONE]"));
            lore.add(net.kyori.adventure.text.Component.text("§a✔ Completed! Reward: §6" + stageReward + " coins"));
            meta.addEnchant(Enchantment.LURE, 1, true);
            meta.addItemFlags(ItemFlag.HIDE_ENCHANTS);
        } else if (isCurrent) {
            meta.displayName(net.kyori.adventure.text.Component.text("§e§l⭐ Stage " + stage + ": " + title + (isActive ? " §a[ACTIVE]" : " §e[CURRENT]")));
            if ("starter_iron".equals(kind)) {
                int mined = isActive ? active.get("progress").getAsInt() : 0;
                int smelted = isActive ? active.get("secondary_progress").getAsInt() : 0;
                int total = mined + smelted;
                int max = target * 2;
                int pct = max > 0 ? (int) Math.round(((double) total / max) * 100) : 0;
                lore.add(net.kyori.adventure.text.Component.text("§f • Mine Iron Ore: §e" + mined + "/" + target));
                lore.add(net.kyori.adventure.text.Component.text("§f • Smelt Iron Ingots: §e" + smelted + "/" + target));
                lore.add(net.kyori.adventure.text.Component.text("§7Live Progress: " + formatQuestProgressBar(total, max, 12) + " §b" + pct + "%"));
            } else {
                int prog = isActive ? active.get("progress").getAsInt() : 0;
                int pct = target > 0 ? (int) Math.round(((double) prog / target) * 100) : 0;
                lore.add(net.kyori.adventure.text.Component.text("§f • Objective: §e" + prog + "/" + target));
                lore.add(net.kyori.adventure.text.Component.text("§7Live Progress: " + formatQuestProgressBar(prog, target, 12) + " §b" + pct + "%"));
            }
            lore.add(net.kyori.adventure.text.Component.text("§7Stage Reward: §6" + stageReward + " coins"));
            lore.add(net.kyori.adventure.text.Component.text("§8--------------------------------"));
            if (isActive) {
                lore.add(net.kyori.adventure.text.Component.text("§a§l▶ Currently tracking progress"));
                meta.addEnchant(Enchantment.LURE, 1, true);
                meta.addItemFlags(ItemFlag.HIDE_ENCHANTS);
            } else {
                lore.add(net.kyori.adventure.text.Component.text("§e§lClick to Begin Stage " + stage + "!"));
            }
        } else {
            meta.displayName(net.kyori.adventure.text.Component.text("§c§l🔒 Stage " + stage + ": " + title));
            lore.add(net.kyori.adventure.text.Component.text("§cLocked! Complete Stage " + (stage - 1) + " first."));
            lore.add(net.kyori.adventure.text.Component.text("§7Target: §e" + target + " §7| Reward: §6" + stageReward + " coins"));
        }
        meta.lore(lore);
        item.setItemMeta(meta);
        return item;
    }

    private ItemStack createLockedContractItem(String kindName, int target, long reward, Material icon) {
        ItemStack item = new ItemStack(Material.IRON_BARS);
        ItemMeta meta = item.getItemMeta();
        if (meta != null) {
            meta.displayName(net.kyori.adventure.text.Component.text("§c§l🔒 " + kindName + " Contract"));
            meta.lore(List.of(
                net.kyori.adventure.text.Component.text("§7Requirement: §eComplete all 4 Starter Stages"),
                net.kyori.adventure.text.Component.text("§7Target: §e" + target + " §7| Daily Limit: §b2 contracts/day"),
                net.kyori.adventure.text.Component.text(""),
                net.kyori.adventure.text.Component.text("§8Graduate from the Starter Trials to unlock.")
            ));
            item.setItemMeta(meta);
        }
        return item;
    }

    private ItemStack createDailyContractItem(String kind, String displayName, String desc, int target, long reward,
                                              Material icon, com.google.gson.JsonObject active, boolean limitReached) {
        ItemStack item = new ItemStack(icon);
        ItemMeta meta = item.getItemMeta();
        if (meta == null) return item;

        boolean isActive = active != null && kind.equals(active.get("kind").getAsString()) && "active".equals(active.get("status").getAsString());
        boolean otherActive = active != null && !kind.equals(active.get("kind").getAsString()) && "active".equals(active.get("status").getAsString());

        List<net.kyori.adventure.text.Component> lore = new ArrayList<>();
        lore.add(net.kyori.adventure.text.Component.text("§7" + desc));
        lore.add(net.kyori.adventure.text.Component.text("§8--------------------------------"));

        if (isActive) {
            int progress = active.get("progress").getAsInt();
            int actTarget = active.get("target").getAsInt();
            long actReward = active.get("reward").getAsLong();
            int pct = actTarget > 0 ? (int) Math.round(((double) progress / actTarget) * 100) : 0;

            meta.displayName(net.kyori.adventure.text.Component.text("§a§l" + displayName + " §2[ACTIVE]"));
            lore.add(net.kyori.adventure.text.Component.text("§7Objective: §e" + progress + "/" + actTarget));
            lore.add(net.kyori.adventure.text.Component.text("§7Live Progress: " + formatQuestProgressBar(progress, actTarget, 12) + " §b" + pct + "%"));
            lore.add(net.kyori.adventure.text.Component.text("§7Contract Reward: §6" + actReward + " coins"));
            if (active.has("expires")) {
                lore.add(net.kyori.adventure.text.Component.text("§7Expires in: §e" + formatQuestExpiry(active.get("expires").getAsLong())));
            }
            lore.add(net.kyori.adventure.text.Component.text("§8--------------------------------"));
            lore.add(net.kyori.adventure.text.Component.text("§a§l▶ Currently in progress"));
            meta.addEnchant(Enchantment.LURE, 1, true);
            meta.addItemFlags(ItemFlag.HIDE_ENCHANTS);
        } else {
            meta.displayName(net.kyori.adventure.text.Component.text(displayName));
            lore.add(net.kyori.adventure.text.Component.text("§7Objective Target: §e" + target));
            lore.add(net.kyori.adventure.text.Component.text("§7Funded Reward: §6" + reward + " coins"));
            lore.add(net.kyori.adventure.text.Component.text("§8--------------------------------"));
            if (otherActive) {
                lore.add(net.kyori.adventure.text.Component.text("§eAnother contract is currently in progress."));
            } else if (limitReached) {
                lore.add(net.kyori.adventure.text.Component.text("§cDaily limit of 2 contracts reached today."));
            } else {
                lore.add(net.kyori.adventure.text.Component.text("§a§lClick to Accept Contract!"));
            }
        }
        meta.lore(lore);
        item.setItemMeta(meta);
        return item;
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
        if(args.length==0) {player.sendMessage("[Economy] /services repair shows a quote for the held iron equipment or golden/diamond/netherite armor. Repairs cost 10 coins (iron), 15 coins (gold), 60 coins (diamond), or 175 coins (netherite) per quarter durability, at most three units per UTC day; keep 1,000 coins. Private-block travel is not available yet.");return;}
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
        if(item.isEmpty()||item.getAmount()!=1||!RepairRules.isRepairableMaterial(item.getType().name())||!(item.getItemMeta() instanceof org.bukkit.inventory.meta.Damageable damage)||damage.getDamage()<=0) {player.sendMessage("[Economy] Hold a damaged iron tool, weapon or armor item, or a golden/diamond/netherite armor item.");return;}
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
                addCapped(countersFor(player).playSeconds, seconds);
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
        addCapped(countersFor(player).blocksPlaced, 1);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onBlockBroken(BlockBreakEvent event) {
        Player player = event.getPlayer();
        // MONITOR is the last word on the event, so the cancellation decision is final.
        if (!isAuthenticated(player) || event.isCancelled()) {
            return;
        }
        lastActive.put(player.getUniqueId(),System.currentTimeMillis());
        addCapped(countersFor(player).blocksBroken, 1);
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
        if (activeTeleportWarmups.containsKey(event.getPlayer().getUniqueId())) {
            cancelTeleportWarmup(event.getPlayer(), "Fast travel cancelled because you moved!");
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
        addCapped(countersFor(player).distanceCm, Math.round(blocks * 100.0));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onEntityDeath(EntityDeathEvent event) {
        Player killer = event.getEntity().getKiller();
        if (killer != null && isAuthenticated(killer)) {
            addCapped(countersFor(killer).mobsKilled, 1);
            economyKill(event,killer);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onPlayerDeath(PlayerDeathEvent event) {
        Player player = event.getEntity();
        if (isAuthenticated(player)) {
            addCapped(countersFor(player).deaths, 1);
        }

        if (player.getWorld().getName().equals("mine_world") || activeMineExpeditions.containsKey(player.getUniqueId())) {
            UUID u = player.getUniqueId();
            mineReturnLocations.remove(u);
            activeMineExpeditions.remove(u);
            var bar = expeditionBossBars.remove(u);
            if (bar != null) {
                player.hideBossBar(bar);
            }
            event.getDrops().clear();
            event.setDroppedExp(0);
            player.getInventory().clear();
            player.sendMessage("§c[Mine] You perished in the Mining Caverns! All items were lost.");
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onPlayerRespawn(org.bukkit.event.player.PlayerRespawnEvent event) {
        Player player = event.getPlayer();
        if (event.getRespawnLocation().getWorld().getName().equals("mine_world")
            || player.getWorld().getName().equals("mine_world")) {
            World overworld = getServer().getWorlds().getFirst();
            event.setRespawnLocation(overworld.getSpawnLocation());
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
        lastCombatMillis.put(player.getUniqueId(), System.currentTimeMillis());
        addCapped(countersFor(player).damageDealt, centiHearts(event.getFinalDamage()));
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
        lastCombatMillis.put(player.getUniqueId(), System.currentTimeMillis());
        if (activeTeleportWarmups.containsKey(player.getUniqueId())) {
            cancelTeleportWarmup(player, "Fast travel cancelled because you took damage!");
        }
        addCapped(countersFor(player).damageTaken, centiHearts(event.getFinalDamage()));
    }

    /** The damage the game finally applied, in hundredths of a heart. */
    private long centiHearts(double damagePoints) {
        // One damage point is half a heart, so 100 centi-hearts per 2 points.
        // An infinite or absurd damage source (some plugins kill with
        // Double.MAX_VALUE) would otherwise round to Long.MAX_VALUE and poison
        // the report the panel accepts.
        if (!Double.isFinite(damagePoints) || damagePoints <= 0.0) {
            return 0L;
        }
        return Math.min(MAX_EVENT_CENTI_HEARTS, Math.max(0L, Math.round(damagePoints * 50.0)));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onCraft(CraftItemEvent event) {
        Player player = event.getWhoClicked() instanceof Player who ? who : null;
        if (player == null || !isAuthenticated(player)) {
            return;
        }
        ItemStack result = event.getRecipe().getResult();
        if (result != null) {
            addCapped(countersFor(player).itemsCrafted, result.getAmount());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPickup(EntityPickupItemEvent event) {
        if (!(event.getEntity() instanceof Player player) || !isAuthenticated(player)) {
            return;
        }
        addCapped(countersFor(player).itemsPickedUp, event.getItem().getItemStack().getAmount());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onCatch(PlayerFishEvent event) {
        if (event.getState() != PlayerFishEvent.State.CAUGHT_FISH) {
            return;
        }
        Player player = event.getPlayer();
        if (isAuthenticated(player)) {
            addCapped(countersFor(player).fishCaught, 1);
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onEnchant(EnchantItemEvent event) {
        Player player = event.getEnchanter();
        if (isAuthenticated(player)) {
            addCapped(countersFor(player).itemsEnchanted, 1);
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onToolBreak(PlayerItemBreakEvent event) {
        Player player = event.getPlayer();
        if (isAuthenticated(player)) {
            addCapped(countersFor(player).toolsBroken, 1);
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onBreed(EntityBreedEvent event) {
        if (!(event.getBreeder() instanceof Player player) || !isAuthenticated(player)) {
            return;
        }
        addCapped(countersFor(player).animalsBred, 1);
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
            addCapped(countersFor(player).timesSlept, 1);
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
            addCapped(countersFor(player).advancements, 1);
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerQuit(PlayerQuitEvent event) {
        UUID uuid = event.getPlayer().getUniqueId();
        repairQuotes.remove(uuid);
        org.bukkit.scheduler.BukkitTask warmup = activeTeleportWarmups.remove(uuid);
        if (warmup != null) {
            warmup.cancel();
        }
        // A quit is a good moment to hand in the pending activity, so "last active"
        // in the panel tracks the disconnect. The panel may be unreachable; the
        // periodic flush still owns the data.
        getServer().getScheduler().runTaskAsynchronously(this, () -> flush(uuid, requestTimeout));
    }

    private Counters countersFor(Player player) {
        names.put(player.getUniqueId(), player.getName());
        return totals.computeIfAbsent(player.getUniqueId(), id -> new Counters());
    }

    /** Adds to a counter, saturating at the panel's unsigned 32-bit ceiling. */
    private static void addCapped(AtomicLong counter, long delta) {
        if (delta <= 0L) {
            return;
        }
        counter.updateAndGet(current -> current > MAX_COUNTER - delta ? MAX_COUNTER : current + delta);
    }

    /**
     * Reports, for one player (or every player when {@code only} is null), the
     * activity measured since the panel last accepted a report for that player.
     *
     * <p>Compute, send, and mark-as-reported happen under one lock, so the timer
     * flush and a quit flush can never hand the panel the same activity twice.
     * A transport failure or a 5xx keeps the delta for the next flush; a 4xx
     * means the body can never be accepted, so it is dropped and logged rather
     * than retried forever. A hard shutdown loses at most the activity measured
     * since the last accepted report.
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
        if (response == null) {
            return false;
        }
        int code = response.statusCode();
        if (code >= 500) {
            return false;
        }
        if (code != 200) {
            // The panel refuses this body on its merits — a counter outside its
            // unsigned 32-bit range, a name it will not accept. Retrying it
            // forever would starve every later report for every player, which is
            // exactly how statistics once stopped for a whole server after one
            // bad damage value. Drop it, count the delta as reported (so the
            // same poison is never rebuilt from the counters), and carry on.
            getLogger().warning(
                "Dropping a statistics report the panel rejected (" + code + ")"
                    + (pendingBatch.isEmpty()
                        ? ": recovered from disk, nothing to re-count."
                        : ": " + pendingBatch.size() + " player(s) of activity lost."));
            markReported(pendingBatch);
            pendingBatch = List.of();
            pendingBody = null;
            try {
                Files.deleteIfExists(outbox);
            } catch (IOException error) {
                getLogger().warning("Cannot clear rejected statistics report: " + error);
            }
            return true;
        }
        try {
            Files.deleteIfExists(outbox);
        } catch (IOException error) {
            getLogger().warning("Cannot clear accepted statistics report; will safely retry: " + error);
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
        if (item.getItemMeta() instanceof Damageable damageable && item.getType().getMaxDurability() > 0) {
            int max = damageable.hasMaxDamage() ? damageable.getMaxDamage() : item.getType().getMaxDurability();
            int damage = Math.min(Math.max(0, damageable.getDamage()), max);
            slot.append(",\"damage\":").append(damage)
                .append(",\"max_damage\":").append(max);
        } else {
            slot.append(",\"damage\":null,\"max_damage\":null");
        }
        String display = null;
        try {
            var displayComponent = item.getItemMeta() != null && item.getItemMeta().hasDisplayName()
                ? item.getItemMeta().displayName()
                : null;
            if (displayComponent != null) {
                display = net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer.plainText().serialize(displayComponent);
            }
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
            loadAllPlacedPrivateBlocks();
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
                if(deleted) {
                    if (current.getAmount() > 1) {
                        current.setAmount(current.getAmount() - 1);
                    } else {
                        player.getInventory().setItem(index, null);
                    }
                }
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
            deleted = !refresh;
            if(!refresh && !replay) {
                ItemStack it = items.get(index);
                if (it != null && expected.equals(InventoryNbt.fingerprint(it.serializeAsBytes()))) {
                    if (it.getAmount() > 1) {
                        it.setAmount(it.getAmount() - 1);
                        nbt.replaceMarketItem(index, InventoryNbt.read(it.serializeAsBytes()).root);
                        deleted = true;
                    } else {
                        deleted = nbt.delete(index, expected, id);
                        if (deleted) items.remove(index);
                    }
                } else {
                    deleted = false;
                }
            }
            if(!refresh && !replay) nbt.save(file);
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
     * A lost HTTP acknowledgement therefore cannot remove or deliver it twice.
     *
     * Never run this on the server thread: it waits for `callSyncMethod` below,
     * and only the server thread can execute that task. A caller on the server
     * thread (for example a purchase callback) would deadlock the tick loop until
     * the watchdog kills the server, so such a call just hands the work over. */
    private void syncMarketplace() {
        if (getServer().isPrimaryThread()) {
            getServer().getScheduler().runTaskAsynchronously(this, this::syncMarketplace);
            return;
        }
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
            "assets/minecraft/textures/block/" + name + "_top.png",
            "assets/minecraft/textures/block/" + name + "_side.png",
            "assets/minecraft/textures/block/" + name + "_front.png",
            "assets/minecraft/textures/block/" + name + "_side0.png",
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

    private HttpResponse<String> get(String url, Duration timeout) {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(timeout)
                .header("Authorization", "Bearer " + serviceToken)
                .GET()
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

    public ItemStack createProtectionCoreItem(int blockIndex) {
        ItemStack item = new ItemStack(Material.LODESTONE, 1);
        ItemMeta meta = item.getItemMeta();
        meta.displayName(Component.text("§6§l[Protection Core]"));
        meta.lore(List.of(
            Component.text("§7Private Block #" + blockIndex),
            Component.text("§ePlace on the ground to establish a private zone."),
            Component.text("§7Deposit fuel crystals to power and expand (3x3 up to 15x15).")
        ));
        var pdc = meta.getPersistentDataContainer();
        pdc.set(new NamespacedKey(this, "private_core"), org.bukkit.persistence.PersistentDataType.INTEGER, blockIndex);
        item.setItemMeta(meta);
        return item;
    }

    public ItemStack createFuelCrystalItem(int tier) {
        Material mat = switch (tier) {
            case 1 -> Material.RAW_COPPER;
            case 2 -> Material.PRISMARINE_CRYSTALS;
            case 3 -> Material.REDSTONE;
            case 4 -> Material.ECHO_SHARD;
            default -> Material.COAL;
        };
        String name = switch (tier) {
            case 1 -> "§6[Tier 1 Fuel: Ember Shard]";
            case 2 -> "§b[Tier 2 Fuel: Cobalt Crystal]";
            case 3 -> "§c[Tier 3 Fuel: Crimson Core]";
            case 4 -> "§d[Tier 4 Fuel: Astral Void Crystal]";
            default -> "§f[Fuel Crystal]";
        };
        List<Component> lore = switch (tier) {
            case 1 -> List.of(Component.text("§7Deposit in Protection Core:"), Component.text("§a+2 Hours Fuel (2x2 chunks / 32x32)"), Component.text("§8Exclusive Private Fuel"));
            case 2 -> List.of(Component.text("§7Deposit in Protection Core:"), Component.text("§a+3 Hours Fuel (5x5 chunks / 80x80)"), Component.text("§8Exclusive Private Fuel"));
            case 3 -> List.of(Component.text("§7Deposit in Protection Core:"), Component.text("§a+4 Hours Fuel (10x10 chunks / 160x160)"), Component.text("§8Exclusive Private Fuel"));
            case 4 -> List.of(Component.text("§7Deposit in Protection Core:"), Component.text("§a+6 Hours Fuel (16x16 chunks / 256x256 - MAX)"), Component.text("§8Exclusive Private Fuel"));
            default -> List.of(Component.text("§7Deposit in Protection Core for fuel"));
        };
        ItemStack item = new ItemStack(mat, 1);
        ItemMeta meta = item.getItemMeta();
        meta.displayName(Component.text(name));
        meta.lore(lore);
        var pdc = meta.getPersistentDataContainer();
        pdc.set(new NamespacedKey(this, "fuel_tier"), org.bukkit.persistence.PersistentDataType.INTEGER, tier);
        item.setItemMeta(meta);
        return item;
    }

    public ItemStack createProspectorPickaxeItem(int tier) {
        Material mat = switch (tier) {
            case 1 -> Material.GOLDEN_PICKAXE;
            case 2 -> Material.IRON_PICKAXE;
            case 3 -> Material.DIAMOND_PICKAXE;
            case 4 -> Material.NETHERITE_PICKAXE;
            default -> Material.IRON_PICKAXE;
        };
        String name = PickaxeRules.pickaxeName(tier);
        ItemStack item = new ItemStack(mat, 1);
        ItemMeta meta = item.getItemMeta();
        meta.displayName(Component.text(name));
        meta.lore(List.of(
            Component.text("§7Prospector Mining Tool"),
            Component.text("§eCan harvest up to Tier " + tier + " fuel crystals."),
            Component.text("§8Exclusive Mining Dimension Tool")
        ));
        var pdc = meta.getPersistentDataContainer();
        pdc.set(new NamespacedKey(this, "prospector_tier"), org.bukkit.persistence.PersistentDataType.INTEGER, tier);
        item.setItemMeta(meta);
        return item;
    }

    private void initializePrivateAndMining() {
        creeperTriggerKey = new NamespacedKey(this, "creeper_trigger");
        raidTntKey = new NamespacedKey(this, "raid_tnt");
        breachZoneKey = new NamespacedKey(this, "breach_zone");
        if (getCommand("ps") != null) {
            getCommand("ps").setExecutor(this);
            getCommand("ps").setTabCompleter((sender, cmd, alias, args) -> {
                if (args.length == 1) {
                    return List.of("buy", "list", "claim", "tp", "home", "add", "remove", "info", "raid").stream()
                        .filter(s -> s.startsWith(args[0].toLowerCase(Locale.ROOT))).toList();
                }
                if (args.length == 2 && (args[0].equalsIgnoreCase("tp") || args[0].equalsIgnoreCase("home"))) {
                    return List.of("1", "2", "3").stream()
                        .filter(s -> s.startsWith(args[1])).toList();
                }
                return List.of();
            });
        }
        if (getCommand("home") != null) {
            getCommand("home").setExecutor(this);
            getCommand("home").setTabCompleter((sender, cmd, alias, args) -> {
                if (args.length == 1) {
                    return List.of("1", "2", "3").stream()
                        .filter(s -> s.startsWith(args[0])).toList();
                }
                return List.of();
            });
        }
        loadAllPlacedPrivateBlocks();
        if (getCommand("raid") != null) {
            getCommand("raid").setExecutor(this);
            getCommand("raid").setTabCompleter((sender, cmd, alias, args) -> {
                if (args.length == 1) {
                    return List.of("buy", "tnt", "help").stream()
                        .filter(s -> s.startsWith(args[0].toLowerCase(Locale.ROOT))).toList();
                }
                if (args.length == 2 && args[0].equalsIgnoreCase("buy")) {
                    return List.of("tnt").stream()
                        .filter(s -> s.startsWith(args[1].toLowerCase(Locale.ROOT))).toList();
                }
                return List.of();
            });
        }
        if (getCommand("mine") != null) {
            getCommand("mine").setExecutor(this);
            getCommand("mine").setTabCompleter((sender, cmd, alias, args) -> {
                if (args.length == 1) {
                    return List.of("enter", "time", "leave", "shop").stream()
                        .filter(s -> s.startsWith(args[0].toLowerCase(Locale.ROOT))).toList();
                }
                return List.of();
            });
        }
        if (getCommand("minershop") != null) {
            getCommand("minershop").setExecutor(this);
            getCommand("minershop").setTabCompleter((sender, cmd, alias, args) -> {
                if (args.length == 1) {
                    return List.of("buy").stream().filter(s -> s.startsWith(args[0].toLowerCase(Locale.ROOT))).toList();
                }
                if (args.length == 2 && args[0].equalsIgnoreCase("buy")) {
                    return List.of("1", "2", "3", "4").stream().filter(s -> s.startsWith(args[1])).toList();
                }
                return List.of();
            });
        }

        try {
            World mineWorld = getServer().getWorld("mine_world");
            if (mineWorld == null) {
                var creator = new org.bukkit.WorldCreator("mine_world");
                creator.environment(World.Environment.NORMAL);
                mineWorld = creator.createWorld();
            }
            if (mineWorld != null) {
                mineWorld.setGameRule(org.bukkit.GameRule.DO_MOB_SPAWNING, true);
                getSafeCaveSpawn(mineWorld);
                for (Chunk c : mineWorld.getLoadedChunks()) {
                    sanitizeMineChunk(c);
                }
            }
        } catch (Exception error) {
            getLogger().warning("Could not initialize mine_world: " + error.getMessage());
        }

        getServer().getScheduler().runTaskTimer(this, () -> {
            long now = System.currentTimeMillis();

            // 1. Expedition timer
            for (var entry : activeMineExpeditions.entrySet()) {
                UUID u = entry.getKey();
                long expires = entry.getValue();
                Player p = getServer().getPlayer(u);
                if (p == null || !p.isOnline()) {
                    activeMineExpeditions.remove(u);
                    var b = expeditionBossBars.remove(u);
                    continue;
                }
                long leftSeconds = (expires - now) / 1000L;
                if (leftSeconds <= 0) {
                    endMineExpedition(p, "Expedition time expired! You have been returned to the surface.");
                } else {
                    var bar = expeditionBossBars.get(u);
                    if (bar != null) {
                        float progress = Math.max(0.0f, Math.min(1.0f, (float) leftSeconds / 300.0f));
                        bar.progress(progress);
                        bar.name(Component.text("⏳ [Mine Expedition] " + ExpeditionRules.formatDuration(leftSeconds) + " remaining"));
                    }
                }
            }

            // 2. Ore regeneration
            var it = regeneratingNodes.entrySet().iterator();
            while (it.hasNext()) {
                var entry = it.next();
                if (now >= entry.getValue().regenAtMs) {
                    Location loc = entry.getKey();
                    if (loc.getWorld() != null && loc.getBlock().getType() == Material.BEDROCK) {
                        loc.getBlock().setType(entry.getValue().originalMaterial);
                        loc.getWorld().spawnParticle(Particle.HAPPY_VILLAGER, loc.clone().add(0.5, 0.5, 0.5), 10);
                        loc.getWorld().playSound(loc, org.bukkit.Sound.BLOCK_AMETHYST_BLOCK_CHIME, 1.0f, 1.2f);
                    }
                    it.remove();
                }
            }

            // 3. Fuel burn
            for (var pb : placedPrivateBlocks.values()) {
                if (pb.placed && pb.totalFuelSeconds() > 0) {
                    int prevTier = pb.fuelTier;
                    pb.tickSecond();
                    if (pb.fuelTier != prevTier) {
                        syncPrivateBlockAsync(pb);
                        Player owner = getServer().getPlayer(pb.ownerUuid);
                        if (owner != null && owner.isOnline()) {
                            owner.sendMessage(String.format(Locale.ROOT,
                                "§e[Private] Protection core #%d transitioned to Tier %d (%dx%d chunks)!",
                                pb.blockIndex, pb.fuelTier, PrivateRules.radiusToChunks(pb.radius), PrivateRules.radiusToChunks(pb.radius)));
                        }
                    }
                }
            }

            // Real-time update for open core GUIs
            for (Map.Entry<UUID, PlacedPrivateBlock> entry : activeCoreGuis.entrySet()) {
                Player p = getServer().getPlayer(entry.getKey());
                if (p != null && p.isOnline()) {
                    var top = p.getOpenInventory().getTopInventory();
                    updateCoreGuiItems(top, entry.getValue());
                }
            }

            // 4. Primed Breach Charges
            for (PrimedCharge pc : primedCharges) {
                pc.ticksRemaining--;
                Location loc = pc.location;
                if (loc.getWorld() != null) {
                    loc.getWorld().spawnParticle(Particle.DUST, loc.clone().add(0, 0.5, 0), 6,
                        new Particle.DustOptions(Color.RED, 1.5f));
                    float pitch = 0.5f + (RaidRules.FUSE_SECONDS - Math.max(0, pc.ticksRemaining)) * 0.15f;
                    loc.getWorld().playSound(loc, Sound.BLOCK_NOTE_BLOCK_HAT, 1.0f, pitch);
                }
                if (pc.ticksRemaining <= 0) {
                    primedCharges.remove(pc);
                    detonateBreachCharge(pc);
                }
            }

            // 5. Active Breaches auto-reconstruction
            var abIt = activeBreaches.entrySet().iterator();
            while (abIt.hasNext()) {
                var entry = abIt.next();
                if (now >= entry.getValue().expiresAtMs) {
                    reconstructBreachedZone(entry.getValue());
                    abIt.remove();
                }
            }
        }, 20L, 20L);
    }

    private void endMineExpedition(Player player, String message) {
        UUID uuid = player.getUniqueId();
        activeMineExpeditions.remove(uuid);
        var bar = expeditionBossBars.remove(uuid);
        if (bar != null) {
            player.hideBossBar(bar);
        }
        Location returnLoc = mineReturnLocations.remove(uuid);
        if (returnLoc != null && returnLoc.getWorld() != null && !returnLoc.getWorld().getName().equals("mine_world")) {
            player.teleport(returnLoc);
        } else {
            World overworld = getServer().getWorlds().getFirst();
            player.teleport(overworld.getSpawnLocation());
        }
        player.playSound(player.getLocation(), org.bukkit.Sound.BLOCK_CHEST_CLOSE, 1.0f, 1.0f);
        if (message != null && !message.isBlank()) {
            player.sendMessage("§e[Mine] " + message);
        }
    }

    private String blockKey(Location loc) {
        return loc.getWorld().getName() + ":" + loc.getBlockX() + ":" + loc.getBlockY() + ":" + loc.getBlockZ();
    }

    private PlacedPrivateBlock getPlacedCoreAt(Location loc) {
        return placedPrivateBlocks.get(blockKey(loc));
    }

    private PlacedPrivateBlock getProtectingBlock(Location loc) {
        String world = loc.getWorld().getName();
        int x = loc.getBlockX();
        int z = loc.getBlockZ();
        for (PlacedPrivateBlock pb : placedPrivateBlocks.values()) {
            if (pb.placed && pb.fuelSeconds > 0 && pb.world.equals(world)) {
                if (PrivateRules.isInside(x, z, pb.x, pb.z, pb.radius)) {
                    return pb;
                }
            }
        }
        return null;
    }

    private void syncPrivateBlockAsync(PlacedPrivateBlock pb) {
        var body = new com.google.gson.JsonObject();
        body.addProperty("uuid", pb.ownerUuid.toString());
        body.addProperty("block_index", pb.blockIndex);
        body.addProperty("world", pb.world);
        body.addProperty("x", pb.x);
        body.addProperty("y", pb.y);
        body.addProperty("z", pb.z);
        body.addProperty("placed", pb.placed);
        body.addProperty("radius", pb.radius);
        body.addProperty("fuel_seconds", pb.fuelSeconds);
        body.addProperty("fuel_tier", pb.fuelTier);
        body.addProperty("tier_1_seconds", pb.tier1Seconds);
        body.addProperty("tier_2_seconds", pb.tier2Seconds);
        body.addProperty("tier_3_seconds", pb.tier3Seconds);
        body.addProperty("tier_4_seconds", pb.tier4Seconds);
        var arr = new com.google.gson.JsonArray();
        for (UUID u : pb.members) arr.add(u.toString());
        body.add("members", arr);
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            post(internalBase + "/private/sync", body.toString(), requestTimeout);
            updateBlueMapMarkers();
        });
    }

    private PlacedPrivateBlock getPlacedBlockByUserAndIndex(UUID ownerUuid, int blockIndex) {
        for (PlacedPrivateBlock pb : placedPrivateBlocks.values()) {
            if (pb.ownerUuid.equals(ownerUuid) && pb.blockIndex == blockIndex && pb.placed) {
                return pb;
            }
        }
        return null;
    }

    private PlacedPrivateBlock getPlacedBlockById(String id) {
        if (id == null) return null;
        for (PlacedPrivateBlock pb : placedPrivateBlocks.values()) {
            if (id.equals(pb.id)) return pb;
        }
        return null;
    }

    private boolean hasCoreItemInInventory(Player player, int blockIndex) {
        var inv = player.getInventory();
        var key = new NamespacedKey(this, "private_core");
        for (ItemStack item : inv.getContents()) {
            if (item != null && item.hasItemMeta()) {
                var pdc = item.getItemMeta().getPersistentDataContainer();
                if (pdc.has(key, org.bukkit.persistence.PersistentDataType.INTEGER)) {
                    Integer idx = pdc.get(key, org.bukkit.persistence.PersistentDataType.INTEGER);
                    if (idx != null && idx == blockIndex) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private void loadAllPlacedPrivateBlocks() {
        if (serviceToken.isBlank() || serviceToken.contains("${")) return;
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            var response = get(internalBase + "/private/list", requestTimeout);
            if (response != null && response.statusCode() == 200) {
                try {
                    var array = com.google.gson.JsonParser.parseString(response.body()).getAsJsonArray();
                    int loaded = 0;
                    for (var elem : array) {
                        var obj = elem.getAsJsonObject();
                        boolean placed = obj.get("placed").getAsBoolean();
                        if (!placed) continue;
                        String id = obj.get("id").getAsString();
                        UUID ownerUuid = UUID.fromString(obj.get("uuid").getAsString());
                        String ownerName = obj.has("username") && !obj.get("username").isJsonNull() ? obj.get("username").getAsString() : ownerUuid.toString();
                        int blockIndex = obj.get("block_index").getAsInt();
                        String world = obj.get("world").getAsString();
                        int x = obj.get("x").getAsInt();
                        int y = obj.get("y").getAsInt();
                        int z = obj.get("z").getAsInt();
                        int radius = obj.get("radius").getAsInt();
                        long fuelSeconds = obj.get("fuel_seconds").getAsLong();
                        int fuelTier = obj.get("fuel_tier").getAsInt();
                        long t1 = obj.has("tier_1_seconds") ? obj.get("tier_1_seconds").getAsLong() : 0L;
                        long t2 = obj.has("tier_2_seconds") ? obj.get("tier_2_seconds").getAsLong() : 0L;
                        long t3 = obj.has("tier_3_seconds") ? obj.get("tier_3_seconds").getAsLong() : 0L;
                        long t4 = obj.has("tier_4_seconds") ? obj.get("tier_4_seconds").getAsLong() : 0L;
                        if (t1 == 0 && t2 == 0 && t3 == 0 && t4 == 0 && fuelSeconds > 0) {
                            switch (fuelTier) {
                                case 1 -> t1 = fuelSeconds;
                                case 2 -> t2 = fuelSeconds;
                                case 3 -> t3 = fuelSeconds;
                                case 4 -> t4 = fuelSeconds;
                                default -> t1 = fuelSeconds;
                            }
                        }
                        List<UUID> members = new ArrayList<>();
                        if (obj.has("members") && obj.get("members").isJsonArray()) {
                            for (var m : obj.get("members").getAsJsonArray()) {
                                try {
                                    members.add(UUID.fromString(m.getAsString()));
                                } catch (Exception ignored) {}
                            }
                        }
                        String key = world + ":" + x + ":" + y + ":" + z;
                        PlacedPrivateBlock existing = placedPrivateBlocks.get(key);
                        if (existing != null) {
                            long totalLoaded = t1 + t2 + t3 + t4;
                            if (totalLoaded > existing.totalFuelSeconds()) {
                                existing.tier1Seconds = t1;
                                existing.tier2Seconds = t2;
                                existing.tier3Seconds = t3;
                                existing.tier4Seconds = t4;
                                existing.fuelSeconds = existing.totalFuelSeconds();
                                existing.fuelTier = existing.activeTier();
                                existing.radius = FuelRules.fuelRadius(existing.fuelTier);
                            }
                            existing.members = members;
                        } else {
                            PlacedPrivateBlock pb = new PlacedPrivateBlock(
                                id, ownerUuid, ownerName, blockIndex, world, x, y, z, true, radius,
                                fuelSeconds, fuelTier, t1, t2, t3, t4, members
                            );
                            placedPrivateBlocks.put(key, pb);
                        }
                        loaded++;
                    }
                    getLogger().info("[Private] Loaded " + loaded + " active placed private block(s) from database.");
                    updateBlueMapMarkers();
                } catch (Exception e) {
                    getLogger().warning("[Private] Could not parse placed private blocks: " + e.getMessage());
                }
            }
        });
    }

    private void setupOverworldBorder() {
        getServer().getScheduler().runTask(this, () -> {
            for (org.bukkit.World world : getServer().getWorlds()) {
                if (world.getEnvironment() == org.bukkit.World.Environment.NORMAL && !world.getName().contains("mining")) {
                    org.bukkit.WorldBorder border = world.getWorldBorder();
                    border.setCenter(0, 0);
                    border.setSize(5000);
                    getLogger().info("[Map] Overworld world border configured to 5000x5000 blocks.");
                }
            }
        });
    }

    private void initBlueMapIntegration() {
        try {
            if (getServer().getPluginManager().getPlugin("BlueMap") != null) {
                de.bluecolored.bluemap.api.BlueMapAPI.onEnable(api -> {
                    getLogger().info("[BlueMap] BlueMap detected, initializing territory markers.");
                    updateBlueMapMarkers();
                });
            }
        } catch (Throwable t) {
            getLogger().info("[BlueMap] BlueMap integration deferred: " + t.getMessage());
        }
    }

    public void updateBlueMapMarkers() {
        try {
            de.bluecolored.bluemap.api.BlueMapAPI.getInstance().ifPresent(api -> {
                de.bluecolored.bluemap.api.markers.MarkerSet markerSet = de.bluecolored.bluemap.api.markers.MarkerSet.builder()
                        .label("Private Territories")
                        .toggleable(true)
                        .defaultHidden(false)
                        .build();

                for (PlacedPrivateBlock pb : placedPrivateBlocks.values()) {
                    if (!pb.placed) continue;
                    String markerId = "core_" + pb.id;
                    String shapeId = "zone_" + pb.id;

                    int size = PrivateRules.radiusToSize(pb.radius);
                    int chunks = PrivateRules.radiusToChunks(pb.radius);
                    long hours = pb.fuelSeconds / 3600;
                    long mins = (pb.fuelSeconds % 3600) / 60;
                    String fuelText = pb.fuelSeconds > 0 ? (hours + "h " + mins + "m") : "<span style='color:#ef4444'>DEPLETED</span>";

                    String detail = "<div style='font-family:sans-serif;padding:6px;min-width:180px;'>"
                            + "<b style='color:#0284c7;font-size:1.1em;'>Protection Core #" + pb.blockIndex + "</b><br>"
                            + "<b>Owner:</b> " + pb.ownerName + "<br>"
                            + "<b>Shield Area:</b> " + size + "×" + size + " (" + chunks + "×" + chunks + " chunks, Full Height)<br>"
                            + "<b>Fuel Remaining:</b> " + fuelText + "<br>"
                            + "<b>Coordinates:</b> " + pb.x + ", " + pb.y + ", " + pb.z
                            + "</div>";

                    de.bluecolored.bluemap.api.markers.POIMarker poi = de.bluecolored.bluemap.api.markers.POIMarker.builder()
                            .label("Core #" + pb.blockIndex + " (" + pb.ownerName + ")")
                            .position(new com.flowpowered.math.vector.Vector3d(pb.x + 0.5, pb.y + 1.2, pb.z + 0.5))
                            .detail(detail)
                            .build();
                    markerSet.getMarkers().put(markerId, poi);

                    if (pb.radius > 0) {
                        de.bluecolored.bluemap.api.math.Shape shape = de.bluecolored.bluemap.api.math.Shape.createRect(
                                pb.x - pb.radius, pb.z - pb.radius,
                                pb.x + pb.radius + 1, pb.z + pb.radius + 1
                        );
                        de.bluecolored.bluemap.api.math.Color lineColor = pb.fuelSeconds > 0
                                ? new de.bluecolored.bluemap.api.math.Color(2, 132, 199, 0.9f)
                                : new de.bluecolored.bluemap.api.math.Color(239, 68, 68, 0.9f);
                        de.bluecolored.bluemap.api.math.Color fillColor = pb.fuelSeconds > 0
                                ? new de.bluecolored.bluemap.api.math.Color(56, 189, 248, 0.25f)
                                : new de.bluecolored.bluemap.api.math.Color(239, 68, 68, 0.2f);

                        de.bluecolored.bluemap.api.markers.ShapeMarker zone = de.bluecolored.bluemap.api.markers.ShapeMarker.builder()
                                .label("Territory: " + pb.ownerName + " (" + chunks + "×" + chunks + " chunks)")
                                .shape(shape, pb.y)
                                .lineColor(lineColor)
                                .fillColor(fillColor)
                                .lineWidth(2)
                                .depthTestEnabled(false)
                                .detail(detail)
                                .build();
                        markerSet.getMarkers().put(shapeId, zone);
                    }
                }

                for (de.bluecolored.bluemap.api.BlueMapMap map : api.getMaps()) {
                    if (map.getWorld().getId().endsWith("overworld") || map.getId().contains("world")) {
                        map.getMarkerSets().put("private-territories", markerSet);
                    }
                }
            });
        } catch (Throwable ignored) {
        }
    }

    private long tabTick = 0;

    private static final String[] AERO_PALETTE = {
        "#38bdf8", "#0ea5e9", "#0284c7", "#2563eb",
        "#3b82f6", "#60a5fa", "#38bdf8", "#06b6d4",
        "#14b8a6", "#0ea5e9"
    };

    private static final String[] SPARKLES = {
        "✦", "✧", "★", "✧", "✦", "✶", "✷", "✸"
    };

    private static final String[] AERO_MOTDS = {
        "Your world, connected.",
        "Interactive 2000×2000 3D Web Map",
        "Live Marketplace & Auction House",
        "Craftable Breach Charges & Raiding",
        "Tiered Base Protection Cores",
        "Regenerating Fuel Ores in the Mine Dimension",
        "Live Web & Server Bidirectional Chat"
    };

    private String buildAeroDivider(long step, int width) {
        StringBuilder sb = new StringBuilder();
        int wavePos = (int) (step % width);
        for (int i = 0; i < width; i++) {
            int dist = Math.abs(i - wavePos);
            if (dist == 0) {
                sb.append("<color:#ffffff><bold>═</bold></color>");
            } else if (dist == 1) {
                sb.append("<color:#7dd3fc><bold>─</bold></color>");
            } else if (dist == 2) {
                sb.append("<color:#0284c7>─</color>");
            } else {
                sb.append("<color:#1e293b>─</color>");
            }
        }
        return sb.toString();
    }

    private void updateTabList() {
        if (!isEnabled()) return;
        var players = getServer().getOnlinePlayers();
        if (players.isEmpty()) return;

        tabTick++;
        net.kyori.adventure.text.minimessage.MiniMessage mm = net.kyori.adventure.text.minimessage.MiniMessage.miniMessage();
        int online = players.size();
        int max = getServer().getMaxPlayers();

        // 1. Shifting animated title gradient
        int colorIdx1 = (int) (tabTick % AERO_PALETTE.length);
        int colorIdx2 = (int) ((tabTick + 4) % AERO_PALETTE.length);
        String titleColor1 = AERO_PALETTE[colorIdx1];
        String titleColor2 = AERO_PALETTE[colorIdx2];

        // 2. Animated twinkling star sparks
        String sparkL = SPARKLES[(int) (tabTick % SPARKLES.length)];
        String sparkR = SPARKLES[(int) ((tabTick + 4) % SPARKLES.length)];

        // 3. Rotating MOTD slogan
        int motdIdx = (int) ((tabTick / 25) % AERO_MOTDS.length);
        String motd = AERO_MOTDS[motdIdx];
        String motdColor = (tabTick % 8 < 4) ? "#7dd3fc" : "#bae6fd";

        // 4. Moving reflection shimmer across glass divider line
        String divider = buildAeroDivider(tabTick, 36);

        // 5. Pulsing live online status indicator
        String pulseDot = (tabTick % 6 < 3) ? "<color:#4ade80>●</color>" : "<color:#22c55e>○</color>";

        // 6. Blinking colon clock
        boolean colonBlink = (tabTick % 4 < 2);
        String timeFormat = colonBlink ? "HH:mm:ss" : "HH mm ss";
        String timeStr = java.time.format.DateTimeFormatter.ofPattern(timeFormat)
                .withZone(java.time.ZoneId.of("UTC"))
                .format(java.time.Instant.now()) + " UTC";

        String site = (panelUrl == null || panelUrl.isBlank() || panelUrl.contains("${"))
                ? "https://localhost"
                : panelUrl.replaceAll("/+$", "");

        // 7. Shimmering website link
        int siteColorIdx = (int) ((tabTick + 2) % AERO_PALETTE.length);
        String siteColor = AERO_PALETTE[siteColorIdx];

        String headerText = "<newline>"
                + "<gradient:" + titleColor1 + ":" + titleColor2 + "><bold>" + sparkL + " OASIS AERO " + sparkR + "</bold></gradient><newline>"
                + "<color:" + motdColor + "><i>✦ " + motd + " ✦</i></color><newline>"
                + divider + "<newline>"
                + "<color:#94a3b8>Online Players:</color> " + pulseDot + " <color:#38bdf8><bold>" + online + "</bold></color><color:#475569>/</color><color:#94a3b8>" + max + "</color>   "
                + "<color:#475569>•</color>   "
                + "<color:#94a3b8>Realm:</color> <color:#38bdf8>Survival 3D</color><newline>";

        for (Player p : players) {
            int ping = p.getPing();
            String pingColor = ping < 60 ? "#4ade80" : (ping < 130 ? "#facc15" : "#f87171");
            String pingDot = ping < 60 ? "<color:#4ade80>●</color>" : "<color:#facc15>▲</color>";

            String footerText = "<newline>"
                    + divider + "<newline>"
                    + "<color:#94a3b8>Your Ping:</color> " + pingDot + " <color:" + pingColor + "><bold>" + ping + "ms</bold></color>   "
                    + "<color:#475569>•</color>   "
                    + "<color:#94a3b8>Server Time:</color> <color:#38bdf8>" + timeStr + "</color><newline>"
                    + "<color:#94a3b8>Website & 3D Map:</color> <gradient:" + siteColor + ":#38bdf8><u>" + site + "</u></gradient><newline>"
                    + "<gradient:#bae6fd:#38bdf8>✦ Trade · Chat · Protect · Explore ✦</gradient><newline>";

            p.sendPlayerListHeaderAndFooter(mm.deserialize(headerText), mm.deserialize(footerText));

            // Animated asynchronous twinkling star next to each player's nickname
            String playerStar = SPARKLES[(int) ((tabTick + Math.abs(p.getName().hashCode())) % SPARKLES.length)];
            String nameFormat = "<color:#38bdf8>" + playerStar + "</color> <color:#f8fafc>" + p.getName() + "</color> <color:#475569>[</color><color:" + pingColor + ">" + ping + "ms</color><color:#475569>]</color>";
            p.playerListName(mm.deserialize(nameFormat));
        }
    }

    private void reclaimPrivateBlocks(Player player) {
        UUID uuid = player.getUniqueId();
        player.sendMessage("[Private] Checking your purchased private blocks...");
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            var response = get(internalBase + "/private/list?uuid=" + uuid, requestTimeout);
            getServer().getScheduler().runTask(this, () -> {
                if (response == null || response.statusCode() != 200) {
                    player.sendMessage("[Private] Cannot contact server right now. Try again shortly.");
                    return;
                }
                try {
                    var array = com.google.gson.JsonParser.parseString(response.body()).getAsJsonArray();
                    if (array.isEmpty()) {
                        player.sendMessage("[Private] You have not purchased any private blocks yet! Use /ps buy.");
                        return;
                    }
                    int reclaimed = 0;
                    for (var elem : array) {
                        var obj = elem.getAsJsonObject();
                        int blockIndex = obj.get("block_index").getAsInt();
                        boolean placed = obj.get("placed").getAsBoolean();
                        String worldName = obj.get("world").getAsString();
                        int x = obj.get("x").getAsInt();
                        int y = obj.get("y").getAsInt();
                        int z = obj.get("z").getAsInt();

                        if (placed) {
                            World w = getServer().getWorld(worldName);
                            if (w == null || w.getBlockAt(x, y, z).getType() != Material.LODESTONE) {
                                placed = false;
                                placedPrivateBlocks.remove(worldName + ":" + x + ":" + y + ":" + z);
                                PlacedPrivateBlock updated = new PlacedPrivateBlock(
                                    obj.get("id").getAsString(), uuid, player.getName(), blockIndex,
                                    worldName, x, y, z, false, obj.get("radius").getAsInt(),
                                    obj.get("fuel_seconds").getAsLong(), obj.get("fuel_tier").getAsInt(),
                                    new ArrayList<>()
                                );
                                syncPrivateBlockAsync(updated);
                            }
                        }

                        if (!placed) {
                            if (!hasCoreItemInInventory(player, blockIndex)) {
                                var leftovers = player.getInventory().addItem(createProtectionCoreItem(blockIndex));
                                if (!leftovers.isEmpty()) {
                                    for (ItemStack leftover : leftovers.values()) {
                                        player.getWorld().dropItemNaturally(player.getLocation(), leftover);
                                    }
                                }
                                reclaimed++;
                                player.sendMessage(String.format(Locale.ROOT,
                                    "§a[Private] Recovered your purchased Protection Core #%d for free!", blockIndex));
                            } else {
                                player.sendMessage(String.format(Locale.ROOT,
                                    "§e[Private] Protection Core #%d is already in your inventory.", blockIndex));
                            }
                        } else {
                            player.sendMessage(String.format(Locale.ROOT,
                                "§7[Private] Protection Core #%d is currently active at %s (%d, %d, %d).",
                                blockIndex, worldName, x, y, z));
                        }
                    }
                    if (reclaimed > 0) {
                        player.playSound(player.getLocation(), org.bukkit.Sound.ENTITY_PLAYER_LEVELUP, 1.0f, 1.0f);
                    }
                } catch (Exception e) {
                    player.sendMessage("[Private] Error reading your private block status.");
                }
            });
        });
    }

    private void openPsMenuGui(Player player) {
        UUID uuid = player.getUniqueId();
        player.sendMessage("§e[Private] Opening protection manager...");
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            var listResp = get(internalBase + "/private/list?uuid=" + uuid, requestTimeout);
            long coins = 0L;
            var balResp = post(internalBase + "/balance", "{\"uuid\":\"" + uuid + "\"}", requestTimeout);
            if (balResp != null && balResp.statusCode() == 200) {
                try {
                    coins = com.google.gson.JsonParser.parseString(balResp.body()).getAsJsonObject().get("coins").getAsLong();
                } catch (Exception ignored) {}
            }
            long finalCoins = coins;
            com.google.gson.JsonArray array = new com.google.gson.JsonArray();
            if (listResp != null && listResp.statusCode() == 200) {
                try {
                    array = com.google.gson.JsonParser.parseString(listResp.body()).getAsJsonArray();
                } catch (Exception ignored) {}
            }
            com.google.gson.JsonArray finalArray = array;

            getServer().getScheduler().runTask(this, () -> {
                if (!player.isOnline()) return;

                PsMenuHolder holder = new PsMenuHolder(finalArray, finalCoins);
                Inventory inv = org.bukkit.Bukkit.createInventory(holder, 27, Component.text("§8Protection Cores & Travel"));
                holder.setInventory(inv);

                ItemStack pane = new ItemStack(Material.GRAY_STAINED_GLASS_PANE);
                ItemMeta pm = pane.getItemMeta();
                if (pm != null) {
                    pm.displayName(Component.text(" "));
                    pane.setItemMeta(pm);
                }
                for (int i = 0; i < 27; i++) {
                    inv.setItem(i, pane.clone());
                }

                Map<Integer, com.google.gson.JsonObject> owned = new HashMap<>();
                for (var elem : finalArray) {
                    var obj = elem.getAsJsonObject();
                    owned.put(obj.get("block_index").getAsInt(), obj);
                }

                // Slots for cores 1, 2, 3: 11, 13, 15
                int[] coreSlots = {11, 13, 15};
                for (int idx = 1; idx <= 3; idx++) {
                    int slot = coreSlots[idx - 1];
                    if (owned.containsKey(idx)) {
                        var obj = owned.get(idx);
                        boolean placed = obj.get("placed").getAsBoolean();
                        long fuel = obj.get("fuel_seconds").getAsLong();
                        int size = obj.get("size").getAsInt();
                        int chunks = PrivateRules.radiusToChunks(PrivateRules.sizeToRadius(size));

                        ItemStack coreItem = new ItemStack(placed ? (fuel > 0 ? Material.BEACON : Material.LODESTONE) : Material.RESPAWN_ANCHOR);
                        ItemMeta meta = coreItem.getItemMeta();
                        if (meta != null) {
                            meta.displayName(Component.text(String.format(Locale.ROOT, "§6§lProtection Core #%d", idx)));
                            List<Component> lore = new ArrayList<>();
                            if (placed) {
                                String loc = String.format(Locale.ROOT, "%s (%d, %d, %d)",
                                    obj.get("world").getAsString(), obj.get("x").getAsInt(), obj.get("y").getAsInt(), obj.get("z").getAsInt());
                                lore.add(Component.text("§7Status: §aPlaced & Active"));
                                lore.add(Component.text("§7Location: §f" + loc));
                                lore.add(Component.text(String.format(Locale.ROOT, "§7Size: §e%dx%d blocks §7(%dx%d chunks)", size, size, chunks, chunks)));
                                lore.add(Component.text("§7Fuel remaining: " + (fuel > 0 ? "§a" + ExpeditionRules.formatDuration(fuel) : "§cDormant (No Fuel)")));
                                lore.add(Component.text(""));
                                if (fuel > 0) {
                                    lore.add(Component.text("§a§l▶ Click to Fast-Travel §7(25 coins)"));
                                } else {
                                    lore.add(Component.text("§cCannot fast-travel: Core needs fuel crystals"));
                                }
                            } else {
                                boolean inInv = hasCoreItemInInventory(player, idx);
                                lore.add(Component.text("§7Status: §ePurchased (Not Placed)"));
                                if (inInv) {
                                    lore.add(Component.text("§a✔ Currently in your inventory (Place down to activate)"));
                                } else {
                                    lore.add(Component.text("§cMissing / Not in inventory"));
                                    lore.add(Component.text(""));
                                    lore.add(Component.text("§e§l▶ Click to Reclaim for Free"));
                                }
                            }
                            meta.lore(lore);
                            coreItem.setItemMeta(meta);
                        }
                        inv.setItem(slot, coreItem);
                    } else {
                        // Not purchased yet
                        long price = PrivateRules.nextBlockPrice(idx - 1);
                        boolean canAfford = finalCoins >= price + 1000L;
                        boolean isNextInQueue = (idx == owned.size() + 1);

                        ItemStack lockItem = new ItemStack(isNextInQueue ? Material.NETHER_STAR : Material.BARRIER);
                        ItemMeta meta = lockItem.getItemMeta();
                        if (meta != null) {
                            meta.displayName(Component.text(String.format(Locale.ROOT, "§7Protection Core #%d §8[Locked]", idx)));
                            List<Component> lore = new ArrayList<>();
                            lore.add(Component.text(String.format(Locale.ROOT, "§7Purchase Cost: §6%,d coins", price)));
                            lore.add(Component.text("§7Territory: 2x2 up to 16x16 chunks, full world height"));
                            lore.add(Component.text(""));
                            if (isNextInQueue) {
                                if (canAfford) {
                                    lore.add(Component.text("§a§l▶ Click to Purchase!"));
                                } else {
                                    lore.add(Component.text("§cInsufficient coins (1,000c reserve required)"));
                                }
                            } else {
                                lore.add(Component.text("§8Purchase Core #" + (idx - 1) + " first"));
                            }
                            meta.lore(lore);
                            lockItem.setItemMeta(meta);
                        }
                        inv.setItem(slot, lockItem);
                    }
                }

                // Balance info at slot 4
                ItemStack bal = new ItemStack(Material.GOLD_INGOT);
                ItemMeta bm = bal.getItemMeta();
                if (bm != null) {
                    bm.displayName(Component.text("§6§lYour Coin Balance"));
                    bm.lore(List.of(
                        Component.text(String.format(Locale.ROOT, "§7Available: §6%,d coins", finalCoins)),
                        Component.text("§7Fast-travel fee: §e25 coins"),
                        Component.text("§7Minimum required reserve: §e1,000 coins")
                    ));
                    bal.setItemMeta(bm);
                }
                inv.setItem(4, bal);

                // Reclaim all button at slot 22
                ItemStack reclaim = new ItemStack(Material.HOPPER);
                ItemMeta rm = reclaim.getItemMeta();
                if (rm != null) {
                    rm.displayName(Component.text("§e§lReclaim All Missing Cores"));
                    rm.lore(List.of(
                        Component.text("§7Recover any unplaced cores that were lost"),
                        Component.text("§7or destroyed back into your inventory."),
                        Component.text(""),
                        Component.text("§e▶ Click to Reclaim")
                    ));
                    reclaim.setItemMeta(rm);
                }
                inv.setItem(22, reclaim);

                player.openInventory(inv);
                player.playSound(player.getLocation(), Sound.BLOCK_CHEST_OPEN, 0.8f, 1.2f);
            });
        });
    }

    private void handlePsMenuClick(Player player, PsMenuHolder holder, int slot) {
        if (slot == 22) {
            player.closeInventory();
            reclaimPrivateBlocks(player);
            return;
        }

        int targetIdx = switch (slot) {
            case 11 -> 1;
            case 13 -> 2;
            case 15 -> 3;
            default -> 0;
        };
        if (targetIdx == 0) return;

        Map<Integer, com.google.gson.JsonObject> owned = new HashMap<>();
        for (var elem : holder.getBlocks()) {
            var obj = elem.getAsJsonObject();
            owned.put(obj.get("block_index").getAsInt(), obj);
        }

        if (owned.containsKey(targetIdx)) {
            var obj = owned.get(targetIdx);
            boolean placed = obj.get("placed").getAsBoolean();
            if (placed) {
                player.closeInventory();
                handlePrivateTeleport(player, targetIdx);
            } else {
                boolean inInv = hasCoreItemInInventory(player, targetIdx);
                if (inInv) {
                    player.playSound(player.getLocation(), Sound.ENTITY_VILLAGER_YES, 0.8f, 1.0f);
                    player.sendMessage("§e[Private] Protection Core #" + targetIdx + " is already in your inventory! Place it on the ground.");
                } else {
                    player.closeInventory();
                    player.getInventory().addItem(createProtectionCoreItem(targetIdx));
                    player.playSound(player.getLocation(), Sound.ENTITY_PLAYER_LEVELUP, 1.0f, 1.0f);
                    player.sendMessage(String.format(Locale.ROOT,
                        "§a[Private] Recovered Protection Core #%d for free into your inventory!", targetIdx));
                }
            }
        } else {
            // Check if it's the next purchasable core
            if (targetIdx == owned.size() + 1) {
                player.closeInventory();
                psCommand(player, new String[]{"buy"});
            } else {
                player.playSound(player.getLocation(), Sound.ENTITY_VILLAGER_NO, 1.0f, 0.8f);
                player.sendMessage("§c[Private] You must purchase Core #" + (targetIdx - 1) + " first!");
            }
        }
    }

    private void psCommand(Player player, String[] args) {
        if (args.length == 0 || args[0].equalsIgnoreCase("gui") || args[0].equalsIgnoreCase("menu")) {
            openPsMenuGui(player);
            return;
        }
        if (args[0].equalsIgnoreCase("help")) {
            player.sendMessage("§6=== Private Block System ===");
            player.sendMessage("§e/ps buy §7— Buy next private block (1/3: 500c, 2/3: 20k, 3/3: 50k)");
            player.sendMessage("§e/ps tp [1|2|3] §7— Fast travel to your placed & fueled core (25c, 3s warmup)");
            player.sendMessage("§e/home [1|2|3] §7— Quick alias for /ps tp");
            player.sendMessage("§e/ps claim §7— Recover any destroyed or lost private blocks for free");
            player.sendMessage("§e/ps list §7— List all your owned private blocks and status");
            player.sendMessage("§e/ps add <player> §7— Add a trusted friend to current private block");
            player.sendMessage("§e/ps remove <player> §7— Remove friend from current private block");
            player.sendMessage("§e/ps info §7— View details of the private block where you stand");
            player.sendMessage("§e/ps raid §7— Base raiding rules and breach charges");
            return;
        }
        if (args[0].equalsIgnoreCase("tp") || args[0].equalsIgnoreCase("teleport") || args[0].equalsIgnoreCase("home")) {
            int targetIndex = 1;
            if (args.length >= 2) {
                try {
                    targetIndex = Integer.parseInt(args[1]);
                } catch (NumberFormatException e) {
                    player.sendMessage("§c[Private] Usage: /ps tp [1|2|3] or /home [1|2|3]");
                    return;
                }
            }
            if (targetIndex < 1 || targetIndex > 3) {
                player.sendMessage("§c[Private] Invalid Protection Core index. Choose 1, 2, or 3.");
                return;
            }
            handlePrivateTeleport(player, targetIndex);
            return;
        }
        if (args[0].equalsIgnoreCase("raid")) {
            raidCommand(player, java.util.Arrays.copyOfRange(args, 1, args.length));
            return;
        }
        if (args[0].equalsIgnoreCase("claim") || args[0].equalsIgnoreCase("get") || args[0].equalsIgnoreCase("reclaim")) {
            reclaimPrivateBlocks(player);
            return;
        }
        if (args[0].equalsIgnoreCase("buy")) {
            UUID uuid = player.getUniqueId();
            String username = player.getName();
            player.sendMessage("[Private] Checking private block availability...");
            getServer().getScheduler().runTaskAsynchronously(this, () -> {
                var listResp = get(internalBase + "/private/list?uuid=" + uuid, requestTimeout);
                getServer().getScheduler().runTask(this, () -> {
                    if (listResp != null && listResp.statusCode() == 200) {
                        try {
                            var array = com.google.gson.JsonParser.parseString(listResp.body()).getAsJsonArray();
                            for (var elem : array) {
                                var obj = elem.getAsJsonObject();
                                int idx = obj.get("block_index").getAsInt();
                                boolean placed = obj.get("placed").getAsBoolean();
                                if (!placed && !hasCoreItemInInventory(player, idx)) {
                                    player.getInventory().addItem(createProtectionCoreItem(idx));
                                    player.playSound(player.getLocation(), org.bukkit.Sound.ENTITY_PLAYER_LEVELUP, 1.0f, 1.0f);
                                    player.sendMessage(String.format(Locale.ROOT,
                                        "§a[Private] You already own Protection Core #%d! Recovered it for free into your inventory.", idx));
                                    return;
                                }
                            }
                            if (array.size() >= 3) {
                                player.sendMessage("§e[Private] You already own the maximum of 3 private blocks! Use /ps list or /ps claim to manage them.");
                                return;
                            }
                        } catch (Exception ignored) {}
                    }

                    getServer().getScheduler().runTaskAsynchronously(this, () -> {
                        var response = post(internalBase + "/private/buy",
                            "{\"uuid\":\"" + uuid + "\",\"username\":\"" + jsonEscape(username) + "\"}", requestTimeout);
                        getServer().getScheduler().runTask(this, () -> {
                            if (response == null) {
                                player.sendMessage("[Private] Server did not respond. No coins charged.");
                                return;
                            }
                            if (response.statusCode() == 200) {
                                try {
                                    var json = com.google.gson.JsonParser.parseString(response.body()).getAsJsonObject();
                                    int blockIndex = json.get("block_index").getAsInt();
                                    long price = json.get("price").getAsLong();
                                    ItemStack core = createProtectionCoreItem(blockIndex);
                                    player.getInventory().addItem(core);
                                    player.playSound(player.getLocation(), org.bukkit.Sound.ENTITY_PLAYER_LEVELUP, 1.0f, 1.0f);
                                    player.sendMessage(String.format(Locale.ROOT,
                                        "§a[Private] Purchased Private Block #%d for %,d coins! Place it to establish your zone.",
                                        blockIndex, price));
                                } catch (Exception e) {
                                    player.sendMessage("[Private] Error reading purchase response.");
                                }
                            } else if (response.statusCode() == 409) {
                                player.sendMessage("[Private] You already own the maximum of 3 private blocks!");
                            } else if (response.statusCode() == 402) {
                                player.sendMessage("[Private] Insufficient coins! Keep at least 1,000 coins in reserve.");
                            } else {
                                player.sendMessage("[Private] Cannot purchase private block at this time (" + response.statusCode() + ").");
                            }
                        });
                    });
                });
            });
            return;
        }
        if (args[0].equalsIgnoreCase("list")) {
            UUID uuid = player.getUniqueId();
            getServer().getScheduler().runTaskAsynchronously(this, () -> {
                var response = get(internalBase + "/private/list?uuid=" + uuid, requestTimeout);
                getServer().getScheduler().runTask(this, () -> {
                    if (response == null || response.statusCode() != 200) {
                        player.sendMessage("[Private] Cannot fetch your private blocks right now.");
                        return;
                    }
                    try {
                        var array = com.google.gson.JsonParser.parseString(response.body()).getAsJsonArray();
                        player.sendMessage("§6=== Your Private Blocks (" + array.size() + "/3 Purchased) ===");
                        Map<Integer, com.google.gson.JsonObject> owned = new HashMap<>();
                        for (var elem : array) {
                            var obj = elem.getAsJsonObject();
                            owned.put(obj.get("block_index").getAsInt(), obj);
                        }
                        for (int i = 1; i <= 3; i++) {
                            if (owned.containsKey(i)) {
                                var obj = owned.get(i);
                                boolean placed = obj.get("placed").getAsBoolean();
                                long fuel = obj.get("fuel_seconds").getAsLong();
                                int size = obj.get("size").getAsInt();
                                if (placed) {
                                    String loc = String.format(Locale.ROOT, "%s (%d, %d, %d)",
                                        obj.get("world").getAsString(), obj.get("x").getAsInt(), obj.get("y").getAsInt(), obj.get("z").getAsInt());
                                    player.sendMessage(String.format(Locale.ROOT,
                                        "§e#%d: §aPlaced §7at %s | §bSize: %dx%d | §7Fuel: %s",
                                        i, loc, size, size, fuel > 0 ? "§a" + ExpeditionRules.formatDuration(fuel) : "§cDormant (No Fuel)"));
                                    if (fuel > 0) {
                                        player.sendMessage(String.format(Locale.ROOT, "  §7↳ Type §e/ps tp %d §7or §e/home %d §7to fast-travel (25 coins)", i, i));
                                    }
                                } else {
                                    boolean inInv = hasCoreItemInInventory(player, i);
                                    if (inInv) {
                                        player.sendMessage(String.format(Locale.ROOT, "§e#%d: §7In your inventory (Ready to place)", i));
                                    } else {
                                        player.sendMessage(String.format(Locale.ROOT, "§e#%d: §cNot Placed / Missing §7(Type §a/ps claim §7to recover for free)", i));
                                    }
                                }
                            } else {
                                long price = PrivateRules.nextBlockPrice(i - 1);
                                player.sendMessage(String.format(Locale.ROOT, "§8#%d: Not purchased (Buy for %,d coins with /ps buy)", i, price));
                            }
                        }
                    } catch (Exception e) {
                        player.sendMessage("[Private] Error parsing block list.");
                    }
                });
            });
            return;
        }
        if (args[0].equalsIgnoreCase("info")) {
            PlacedPrivateBlock pb = getProtectingBlock(player.getLocation());
            if (pb == null) {
                player.sendMessage("[Private] You are not currently standing inside any protected zone.");
                return;
            }
            int size = PrivateRules.radiusToSize(pb.radius);
            int chunks = PrivateRules.radiusToChunks(pb.radius);
            player.sendMessage("§6=== Protection Zone Info ===");
            player.sendMessage("§7Owner: §f" + pb.ownerName);
            player.sendMessage(String.format(Locale.ROOT, "§7Size: §e%dx%d blocks §7(%dx%d chunks, Full World Height)", size, size, chunks, chunks));
            player.sendMessage("§7Fuel Queue:");
            player.sendMessage("  §d• Tier 4 (16x16): §f" + ExpeditionRules.formatDuration(pb.tier4Seconds) + (pb.tier4Seconds > 0 ? " §a[ACTIVE]" : ""));
            player.sendMessage("  §c• Tier 3 (10x10): §f" + ExpeditionRules.formatDuration(pb.tier3Seconds) + (pb.tier4Seconds == 0 && pb.tier3Seconds > 0 ? " §a[ACTIVE]" : ""));
            player.sendMessage("  §b• Tier 2 (5x5):   §f" + ExpeditionRules.formatDuration(pb.tier2Seconds) + (pb.tier4Seconds == 0 && pb.tier3Seconds == 0 && pb.tier2Seconds > 0 ? " §a[ACTIVE]" : ""));
            player.sendMessage("  §6• Tier 1 (2x2):   §f" + ExpeditionRules.formatDuration(pb.tier1Seconds) + (pb.tier4Seconds == 0 && pb.tier3Seconds == 0 && pb.tier2Seconds == 0 && pb.tier1Seconds > 0 ? " §a[ACTIVE]" : ""));
            player.sendMessage("§7Total Fuel: " + (pb.fuelSeconds > 0 ? "§a" + ExpeditionRules.formatDuration(pb.fuelSeconds) : "§c00:00 (Inactive)"));
            player.sendMessage("§7Members: §f" + (pb.members.isEmpty() ? "None" : pb.members.size() + " players"));
            return;
        }
        if (args[0].equalsIgnoreCase("add")) {
            if (args.length < 2) {
                player.sendMessage("[Private] Usage: /ps add <player>");
                return;
            }
            PlacedPrivateBlock pb = getProtectingBlock(player.getLocation());
            if (pb == null || !pb.ownerUuid.equals(player.getUniqueId())) {
                player.sendMessage("[Private] You must be standing inside a private zone that YOU own!");
                return;
            }
            Player target = getServer().getPlayer(args[1]);
            if (target == null || !target.isOnline()) {
                player.sendMessage("[Private] Player '" + args[1] + "' is not online.");
                return;
            }
            if (target.getUniqueId().equals(player.getUniqueId())) {
                player.sendMessage("[Private] You are already the owner of this zone!");
                return;
            }
            if (!pb.members.contains(target.getUniqueId())) {
                pb.members.add(target.getUniqueId());
                syncPrivateBlockAsync(pb);
                player.sendMessage("[Private] Added " + target.getName() + " as a trusted member of this zone.");
                target.sendMessage("[Private] You were added as a trusted member to " + player.getName() + "'s private zone!");
            } else {
                player.sendMessage("[Private] " + target.getName() + " is already a member of this zone.");
            }
            return;
        }
        if (args[0].equalsIgnoreCase("remove")) {
            if (args.length < 2) {
                player.sendMessage("[Private] Usage: /ps remove <player>");
                return;
            }
            PlacedPrivateBlock pb = getProtectingBlock(player.getLocation());
            if (pb == null || !pb.ownerUuid.equals(player.getUniqueId())) {
                player.sendMessage("[Private] You must be standing inside a private zone that YOU own!");
                return;
            }
            Player target = getServer().getPlayer(args[1]);
            UUID targetUuid = target != null ? target.getUniqueId() : null;
            if (targetUuid != null && pb.members.remove(targetUuid)) {
                syncPrivateBlockAsync(pb);
                player.sendMessage("[Private] Removed " + target.getName() + " from this zone.");
            } else {
                player.sendMessage("[Private] Player not found in this zone's member list.");
            }
            return;
        }
        player.sendMessage("[Private] Unknown subcommand. Use /ps for help.");
    }

    private void handlePrivateTeleport(Player player, int targetIndex) {
        PlacedPrivateBlock pb = getPlacedBlockByUserAndIndex(player.getUniqueId(), targetIndex);
        if (pb == null || !pb.placed) {
            player.sendMessage(String.format(Locale.ROOT, "§c[Private] Protection Core #%d is not placed in the world! Use /ps list to view status.", targetIndex));
            return;
        }
        if (pb.fuelSeconds <= 0) {
            player.sendMessage(String.format(Locale.ROOT, "§c[Private] Protection Core #%d is dormant (out of fuel)! Deposit fuel crystals to activate fast travel.", targetIndex));
            return;
        }
        World destinationWorld = getServer().getWorld(pb.world);
        if (destinationWorld == null) {
            player.sendMessage("§c[Private] Destination world '" + pb.world + "' is currently unavailable.");
            return;
        }

        long lastCombat = lastCombatMillis.getOrDefault(player.getUniqueId(), 0L);
        long now = System.currentTimeMillis();
        if (now - lastCombat < 10_000L) {
            long waitSec = (10_000L - (now - lastCombat) + 999) / 1000;
            player.sendMessage("§c[Private] You cannot fast travel while in combat! Wait " + waitSec + "s without taking damage.");
            return;
        }

        long cdUntil = teleportCooldowns.getOrDefault(player.getUniqueId(), 0L);
        if (now < cdUntil) {
            long remainSec = (cdUntil - now + 999) / 1000;
            player.sendMessage("§e[Private] Fast travel is on cooldown. Wait " + remainSec + "s.");
            return;
        }

        if (activeTeleportWarmups.containsKey(player.getUniqueId())) {
            player.sendMessage("§e[Private] You already have an active fast travel in progress!");
            return;
        }

        int landY = pb.y + 1;
        while (landY < destinationWorld.getMaxHeight() - 2 && destinationWorld.getBlockAt(pb.x, landY, pb.z).getType().isSolid()) {
            landY++;
        }
        Location landingLoc = new Location(destinationWorld, pb.x + 0.5, landY, pb.z + 0.5, player.getLocation().getYaw(), player.getLocation().getPitch());

        Location origin = player.getLocation().clone();
        player.sendMessage(String.format(Locale.ROOT,
            "§e[Private] Fast traveling to Protection Core #%d in 3 seconds... Do not move! (Cost: 25 coins)", targetIndex));
        player.playSound(origin, Sound.BLOCK_NOTE_BLOCK_PLING, 1.0f, 1.0f);

        org.bukkit.scheduler.BukkitTask warmupTask = new BukkitRunnable() {
            int ticksElapsed = 0;

            @Override
            public void run() {
                if (!player.isOnline()) {
                    activeTeleportWarmups.remove(player.getUniqueId());
                    cancel();
                    return;
                }
                ticksElapsed += 5;

                Location current = player.getLocation();
                current.getWorld().spawnParticle(Particle.PORTAL, current.clone().add(0, 0.4, 0), 8, 0.2, 0.3, 0.2, 0.05);

                if (ticksElapsed % 20 == 0 && ticksElapsed < 60) {
                    player.playSound(current, Sound.BLOCK_NOTE_BLOCK_PLING, 0.8f, 1.2f);
                }

                if (ticksElapsed >= 60) {
                    activeTeleportWarmups.remove(player.getUniqueId());
                    cancel();
                    executeTeleportAsync(player, targetIndex, landingLoc);
                }
            }
        }.runTaskTimer(this, 5L, 5L);

        activeTeleportWarmups.put(player.getUniqueId(), warmupTask);
    }

    private void cancelTeleportWarmup(Player player, String reason) {
        org.bukkit.scheduler.BukkitTask task = activeTeleportWarmups.remove(player.getUniqueId());
        if (task != null) {
            task.cancel();
            player.sendMessage("§c[Private] " + reason);
            player.playSound(player.getLocation(), Sound.ENTITY_ITEM_BREAK, 1.0f, 0.8f);
        }
    }

    private void executeTeleportAsync(Player player, int targetIndex, Location targetLoc) {
        UUID uuid = player.getUniqueId();
        String username = player.getName();
        player.sendMessage("[Private] Confirming fast travel with economy ledger...");

        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            String payload = "{\"uuid\":\"" + uuid + "\",\"username\":\"" + jsonEscape(username) + "\",\"block_index\":" + targetIndex + "}";
            var response = post(internalBase + "/private/teleport", payload, requestTimeout);

            getServer().getScheduler().runTask(this, () -> {
                if (!player.isOnline()) {
                    return;
                }
                if (response == null) {
                    player.sendMessage("§c[Private] Server did not respond. No coins charged.");
                    return;
                }
                if (response.statusCode() == 200) {
                    try {
                        var json = com.google.gson.JsonParser.parseString(response.body()).getAsJsonObject();
                        long price = json.get("price").getAsLong();
                        long remaining = json.get("remaining_coins").getAsLong();

                        player.teleport(targetLoc);
                        targetLoc.getWorld().spawnParticle(Particle.REVERSE_PORTAL, targetLoc.clone().add(0, 1.0, 0), 50, 0.4, 0.8, 0.4, 0.1);
                        player.playSound(targetLoc, Sound.ENTITY_ENDERMAN_TELEPORT, 1.0f, 1.0f);
                        teleportCooldowns.put(uuid, System.currentTimeMillis() + 30_000L);

                        player.sendMessage(String.format(Locale.ROOT,
                            "§a[Private] Successfully fast-traveled to Protection Core #%d! (-%,d coins, %,d coins remaining)",
                            targetIndex, price, remaining));
                    } catch (Exception e) {
                        player.sendMessage("§c[Private] Error processing teleport response.");
                    }
                } else if (response.statusCode() == 402) {
                    player.sendMessage("§c[Private] Fast travel failed: Insufficient coins! Fast travel costs 25 coins with 1,000 coins protected reserve.");
                    player.playSound(player.getLocation(), Sound.ENTITY_ITEM_BREAK, 1.0f, 0.8f);
                } else if (response.statusCode() == 403) {
                    player.sendMessage(String.format(Locale.ROOT,
                        "§c[Private] Fast travel failed: Protection Core #%d is dormant (out of fuel)!", targetIndex));
                } else if (response.statusCode() == 404 || response.statusCode() == 400) {
                    player.sendMessage(String.format(Locale.ROOT,
                        "§c[Private] Fast travel failed: Protection Core #%d is not placed in the world.", targetIndex));
                } else {
                    player.sendMessage("§c[Private] Fast travel failed (" + response.statusCode() + "). No coins charged.");
                }
            });
        });
    }

    public ItemStack createBreachChargeItem(int amount) {
        ItemStack item = new ItemStack(Material.TNT, amount);
        ItemMeta meta = item.getItemMeta();
        meta.displayName(Component.text("§c§lBreach Charge"));
        meta.lore(List.of(
            Component.text("§7Tactical breaching explosive."),
            Component.text("§7Right-click on an enemy private zone to arm."),
            Component.text("§7Detonates after 10s fuse:"),
            Component.text("§7• Blasts an entry breach (3-block radius)"),
            Component.text("§7• Unlocks containers for 5 minutes"),
            Component.text("§a• 100% Auto-Regeneration when breach expires!")
        ));
        meta.getPersistentDataContainer().set(new NamespacedKey(this, "breach_charge"), org.bukkit.persistence.PersistentDataType.BYTE, (byte) 1);
        item.setItemMeta(meta);
        return item;
    }

    public ItemStack createRaidTntItem(int amount) {
        ItemStack item = new ItemStack(Material.TNT, amount);
        ItemMeta meta = item.getItemMeta();
        meta.displayName(Component.text("§c§lRaid TNT"));
        meta.lore(List.of(
            Component.text("§7Tactical breaching explosive."),
            Component.text("§7Place inside an active raid zone to blast open inner walls & doors!"),
            Component.text("§a• 100% Auto-Regeneration after raid expires.")
        ));
        meta.getPersistentDataContainer().set(new NamespacedKey(this, "raid_tnt"), org.bukkit.persistence.PersistentDataType.BYTE, (byte) 1);
        item.setItemMeta(meta);
        return item;
    }

    public boolean isRaidTnt(ItemStack item) {
        if (item == null || !item.hasItemMeta()) return false;
        return item.getItemMeta().getPersistentDataContainer().has(new NamespacedKey(this, "raid_tnt"), org.bukkit.persistence.PersistentDataType.BYTE);
    }

    private void detonateBreachCharge(PrimedCharge pc) {
        Location center = pc.location;
        World world = center.getWorld();
        if (world == null) return;

        world.spawnParticle(Particle.EXPLOSION_EMITTER, center, 1);
        world.playSound(center, Sound.ENTITY_GENERIC_EXPLODE, 2.0f, 0.8f);

        int radius = RaidRules.BREACH_RADIUS;
        List<BreachedBlock> restoredBlocks = new ArrayList<>();

        int cx = center.getBlockX();
        int cy = center.getBlockY();
        int cz = center.getBlockZ();

        for (int dx = -radius; dx <= radius; dx++) {
            for (int dy = -radius; dy <= radius; dy++) {
                for (int dz = -radius; dz <= radius; dz++) {
                    if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
                    Block b = world.getBlockAt(cx + dx, cy + dy, cz + dz);
                    Material type = b.getType();
                    if (type.isAir() || type == Material.CAVE_AIR || type == Material.VOID_AIR) continue;
                    if (type == Material.BEDROCK) continue;
                    if (type == Material.LODESTONE || getPlacedCoreAt(b.getLocation()) != null) continue;
                    if (type.name().contains("CHEST")
                        || type.name().contains("BARREL")
                        || type.name().contains("SHULKER_BOX")
                        || type.name().contains("HOPPER")
                        || type.name().contains("FURNACE")
                        || type.name().contains("SMOKER")
                        || type.name().contains("DROPPER")
                        || type.name().contains("DISPENSER")) {
                        continue; // Protect containers so their loot is looted safely
                    }

                    restoredBlocks.add(new BreachedBlock(b.getLocation(), b.getBlockData().clone()));
                    b.setType(Material.AIR, false);
                }
            }
        }

        ActiveBreach breach = new ActiveBreach(pc.zoneId, System.currentTimeMillis() + RaidRules.BREACH_DURATION_SECONDS * 1000L, restoredBlocks);
        activeBreaches.put(pc.zoneId, breach);

        Player planter = getServer().getPlayer(pc.planterUuid);
        if (planter != null && planter.isOnline()) {
            planter.sendMessage("§a§l[Raid] Zone breached! You have 5 minutes to raid containers before auto-reconstruction!");
            planter.playSound(planter.getLocation(), Sound.ENTITY_ENDER_DRAGON_GROWL, 1.0f, 1.2f);
        }

        PlacedPrivateBlock pb = getPlacedBlockById(pc.zoneId);
        if (pb != null) {
            reportTerritoryAlertAsync(pb.ownerUuid, "breach", "Base Breached!",
                String.format(Locale.ROOT, "Your base at (%d, %d, %d) was breached by %s! Containers are vulnerable for 5 minutes!", pb.x, pb.y, pb.z, pc.planterName),
                pb.blockIndex, pb.world, pb.x, pb.y, pb.z);
            Player owner = getServer().getPlayer(pb.ownerUuid);
            if (owner != null && owner.isOnline()) {
                owner.sendMessage(String.format(Locale.ROOT,
                    "§4§l[RAID ALERT] §cYour base was breached by %s! Containers are vulnerable for 5 minutes!", pc.planterName));
                owner.playSound(owner.getLocation(), Sound.ENTITY_WITHER_SPAWN, 1.0f, 1.0f);
            }
            for (UUID memberUuid : pb.members) {
                reportTerritoryAlertAsync(memberUuid, "breach", "Team Base Breached!",
                    String.format(Locale.ROOT, "Your team base at (%d, %d, %d) was breached by %s! Containers are vulnerable for 5 minutes!", pb.x, pb.y, pb.z, pc.planterName),
                    pb.blockIndex, pb.world, pb.x, pb.y, pb.z);
                Player member = getServer().getPlayer(memberUuid);
                if (member != null && member.isOnline()) {
                    member.sendMessage(String.format(Locale.ROOT,
                        "§4§l[RAID ALERT] §cYour team base was breached by %s! Containers are vulnerable for 5 minutes!", pc.planterName));
                }
            }
        }
    }

    private void reconstructBreachedZone(ActiveBreach breach) {
        if (breach == null || breach.restoredBlocks == null) return;
        List<BreachedBlock> sorted = new ArrayList<>(breach.restoredBlocks);
        sorted.sort(Comparator.comparingInt(b -> b.location.getBlockY()));

        World world = null;
        Location center = null;
        for (BreachedBlock bb : sorted) {
            if (bb.location == null || bb.location.getWorld() == null) continue;
            world = bb.location.getWorld();
            if (center == null) center = bb.location;

            Block current = bb.location.getBlock();
            if (current.getType().name().contains("CHEST") || current.getType().name().contains("BARREL")) {
                continue;
            }

            if (bb.blockData.getMaterial().isSolid()) {
                int bx = bb.location.getBlockX();
                int by = bb.location.getBlockY();
                int bz = bb.location.getBlockZ();
                for (Player p : world.getPlayers()) {
                    Location ploc = p.getLocation();
                    if (ploc.getBlockX() == bx && (ploc.getBlockY() == by || ploc.getBlockY() == by - 1) && ploc.getBlockZ() == bz) {
                        p.teleport(ploc.clone().add(0, 1.2, 0));
                    }
                }
            }

            bb.location.getBlock().setBlockData(bb.blockData, false);
            world.spawnParticle(Particle.BLOCK, bb.location.clone().add(0.5, 0.5, 0.5), 3, bb.blockData);
        }

        if (world != null && center != null) {
            world.playSound(center, Sound.BLOCK_BEACON_ACTIVATE, 2.0f, 1.0f);
            PlacedPrivateBlock pb = getPlacedBlockById(breach.coreKey);
            if (pb != null) {
                Player owner = getServer().getPlayer(pb.ownerUuid);
                if (owner != null && owner.isOnline()) {
                    owner.sendMessage("§a§l[Raid] Base breach expired. All blocks have been 100% auto-reconstructed!");
                }
                for (UUID memberUuid : pb.members) {
                    Player member = getServer().getPlayer(memberUuid);
                    if (member != null && member.isOnline()) {
                        member.sendMessage("§a§l[Raid] Base breach expired. All blocks have been 100% auto-reconstructed!");
                    }
                }
            }
        }
    }

    private void openRaidShopGui(Player player) {
        UUID uuid = player.getUniqueId();
        player.sendMessage("§e[Raid] Opening Siege & Armory Depot...");
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            long coins = 0L;
            var balResp = post(internalBase + "/balance", "{\"uuid\":\"" + uuid + "\"}", requestTimeout);
            if (balResp != null && balResp.statusCode() == 200) {
                try {
                    coins = com.google.gson.JsonParser.parseString(balResp.body()).getAsJsonObject().get("coins").getAsLong();
                } catch (Exception ignored) {}
            }
            long finalCoins = coins;

            getServer().getScheduler().runTask(this, () -> {
                if (!player.isOnline()) return;

                RaidShopHolder holder = new RaidShopHolder(finalCoins);
                Inventory inv = org.bukkit.Bukkit.createInventory(holder, 27, Component.text("§8Siege & Raiding Armory"));
                holder.setInventory(inv);

                ItemStack pane = new ItemStack(Material.GRAY_STAINED_GLASS_PANE);
                ItemMeta pm = pane.getItemMeta();
                if (pm != null) {
                    pm.displayName(Component.text(" "));
                    pane.setItemMeta(pm);
                }
                for (int i = 0; i < 27; i++) {
                    inv.setItem(i, pane.clone());
                }

                // Balance info header at slot 4
                ItemStack bal = new ItemStack(Material.GOLD_INGOT);
                ItemMeta bm = bal.getItemMeta();
                if (bm != null) {
                    bm.displayName(Component.text("§6§lYour Coin Balance"));
                    bm.lore(List.of(
                        Component.text(String.format(Locale.ROOT, "§7Available: §6%,d coins", finalCoins)),
                        Component.text("§7Required reserve: §e1,000 coins"),
                        Component.text("§7Blasted breaches auto-restore when raid expires!")
                    ));
                    bal.setItemMeta(bm);
                }
                inv.setItem(4, bal);

                // Slot 11: Breach Charge (20,000c)
                ItemStack charge = createBreachChargeItem(1);
                ItemMeta cm = charge.getItemMeta();
                if (cm != null) {
                    List<Component> lore = new ArrayList<>();
                    if (cm.hasLore() && cm.lore() != null) {
                        lore.addAll(cm.lore());
                    }
                    lore.add(Component.text("§8-----------------------------"));
                    lore.add(Component.text(String.format(Locale.ROOT, "§7Price: §6%,d coins", RaidRules.CHARGE_PRICE)));
                    lore.add(Component.text("§7Unlocks enemy chests for 5 minutes."));
                    lore.add(Component.text(""));
                    if (finalCoins >= RaidRules.CHARGE_PRICE + 1000L) {
                        lore.add(Component.text("§a§l▶ Click to Purchase!"));
                    } else {
                        lore.add(Component.text("§cInsufficient coins (1,000c reserve required)"));
                    }
                    cm.lore(lore);
                    charge.setItemMeta(cm);
                }
                inv.setItem(11, charge);

                // Slot 13: 1x Raid TNT (5,000c)
                ItemStack tnt1 = createRaidTntItem(1);
                ItemMeta t1m = tnt1.getItemMeta();
                if (t1m != null) {
                    List<Component> lore = new ArrayList<>();
                    if (t1m.hasLore() && t1m.lore() != null) {
                        lore.addAll(t1m.lore());
                    }
                    lore.add(Component.text("§8-----------------------------"));
                    lore.add(Component.text(String.format(Locale.ROOT, "§7Price: §6%,d coins §7(1 TNT)", RaidRules.TNT_PRICE)));
                    lore.add(Component.text("§7Breaches enemy perimeter walls & doors."));
                    lore.add(Component.text(""));
                    if (finalCoins >= RaidRules.TNT_PRICE + 1000L) {
                        lore.add(Component.text("§a§l▶ Click to Purchase 1x TNT"));
                    } else {
                        lore.add(Component.text("§cInsufficient coins (1,000c reserve required)"));
                    }
                    t1m.lore(lore);
                    tnt1.setItemMeta(t1m);
                }
                inv.setItem(13, tnt1);

                // Slot 15: 5x Raid TNT (25,000c)
                ItemStack tnt5 = createRaidTntItem(5);
                ItemMeta t5m = tnt5.getItemMeta();
                if (t5m != null) {
                    List<Component> lore = new ArrayList<>();
                    if (t5m.hasLore() && t5m.lore() != null) {
                        lore.addAll(t5m.lore());
                    }
                    lore.add(Component.text("§8-----------------------------"));
                    lore.add(Component.text(String.format(Locale.ROOT, "§7Price: §6%,d coins §7(5 TNT bundle)", RaidRules.TNT_PRICE * 5)));
                    lore.add(Component.text("§7Siege bundle to tear through fortified bases."));
                    lore.add(Component.text(""));
                    if (finalCoins >= (RaidRules.TNT_PRICE * 5) + 1000L) {
                        lore.add(Component.text("§a§l▶ Click to Purchase 5x TNT"));
                    } else {
                        lore.add(Component.text("§cInsufficient coins (1,000c reserve required)"));
                    }
                    t5m.lore(lore);
                    tnt5.setItemMeta(t5m);
                }
                inv.setItem(15, tnt5);

                player.openInventory(inv);
                player.playSound(player.getLocation(), Sound.ENTITY_TNT_PRIMED, 0.8f, 1.4f);
            });
        });
    }

    private void handleRaidShopClick(Player player, RaidShopHolder holder, int slot) {
        if (slot == 11) {
            if (holder.getCoinBalance() < RaidRules.CHARGE_PRICE + 1000L) {
                player.playSound(player.getLocation(), Sound.ENTITY_VILLAGER_NO, 1.0f, 0.8f);
                player.sendMessage(String.format(Locale.ROOT,
                    "§c[Raid] You need %,d coins (including 1,000c reserve) to purchase a Breach Charge!",
                    RaidRules.CHARGE_PRICE + 1000L));
                return;
            }
            player.closeInventory();
            raidCommand(player, new String[]{"buy"});
            return;
        }

        if (slot == 13) {
            long price = RaidRules.TNT_PRICE;
            if (holder.getCoinBalance() < price + 1000L) {
                player.playSound(player.getLocation(), Sound.ENTITY_VILLAGER_NO, 1.0f, 0.8f);
                player.sendMessage(String.format(Locale.ROOT,
                    "§c[Raid] You need %,d coins (including 1,000c reserve) to purchase Raid TNT!",
                    price + 1000L));
                return;
            }
            player.closeInventory();
            raidCommand(player, new String[]{"tnt", "1"});
            return;
        }

        if (slot == 15) {
            long price = RaidRules.TNT_PRICE * 5;
            if (holder.getCoinBalance() < price + 1000L) {
                player.playSound(player.getLocation(), Sound.ENTITY_VILLAGER_NO, 1.0f, 0.8f);
                player.sendMessage(String.format(Locale.ROOT,
                    "§c[Raid] You need %,d coins (including 1,000c reserve) to purchase 5x Raid TNT bundle!",
                    price + 1000L));
                return;
            }
            player.closeInventory();
            raidCommand(player, new String[]{"tnt", "5"});
            return;
        }
    }

    private void raidCommand(Player player, String[] args) {
        if (args.length == 0 || args[0].equalsIgnoreCase("gui") || args[0].equalsIgnoreCase("menu")) {
            openRaidShopGui(player);
            return;
        }
        if (args[0].equalsIgnoreCase("help")) {
            player.sendMessage("§6=== Base Raiding & Explosives ===");
            player.sendMessage(String.format(Locale.ROOT, "§e/raid buy §7— Buy a Breach Charge (%,d coins)", RaidRules.CHARGE_PRICE));
            player.sendMessage(String.format(Locale.ROOT, "§e/raid tnt [amount] §7— Buy TNT for breaching walls (%,d coins each)", RaidRules.TNT_PRICE));
            player.sendMessage("§eHow raiding works:");
            player.sendMessage("§7• Place TNT against enemy bases to blast open doors, trapdoors, and walls!");
            player.sendMessage("§7• Arm a Breach Charge to unlock enemy chests for 5 minutes.");
            player.sendMessage("§7• Without a raid you cannot open doors or chests. In a raid you can open only chests.");
            player.sendMessage("§a• 100% Auto-Regeneration: When 5m breach expires, blasted breach restores automatically!");
            return;
        }
        if (args[0].equalsIgnoreCase("tnt") || (args[0].equalsIgnoreCase("buy") && args.length >= 2 && args[1].equalsIgnoreCase("tnt"))) {
            int amount = 10;
            if (args[0].equalsIgnoreCase("tnt") && args.length >= 2) {
                try {
                    amount = Integer.parseInt(args[1].trim());
                } catch (Exception e) {
                    player.sendMessage("[Raid] Usage: /raid tnt <1-64>");
                    return;
                }
            } else if (args[0].equalsIgnoreCase("buy") && args.length >= 3) {
                try {
                    amount = Integer.parseInt(args[2].trim());
                } catch (Exception e) {
                    player.sendMessage("[Raid] Usage: /raid buy tnt <1-64>");
                    return;
                }
            }
            if (amount < 1 || amount > 64) {
                player.sendMessage("[Raid] Amount must be between 1 and 64.");
                return;
            }
            int finalAmount = amount;
            long expectedPrice = finalAmount * RaidRules.TNT_PRICE;
            UUID uuid = player.getUniqueId();
            String username = player.getName();
            player.sendMessage(String.format(Locale.ROOT, "[Raid] Purchasing %dx TNT for %,d coins...", finalAmount, expectedPrice));
            getServer().getScheduler().runTaskAsynchronously(this, () -> {
                var response = post(internalBase + "/raid/tnt",
                    "{\"uuid\":\"" + uuid + "\",\"username\":\"" + jsonEscape(username) + "\",\"amount\":" + finalAmount + "}", requestTimeout);
                getServer().getScheduler().runTask(this, () -> {
                    if (response == null) {
                        player.sendMessage("[Raid] Server did not respond. No coins charged.");
                        return;
                    }
                    if (response.statusCode() == 200) {
                        ItemStack tnt = createRaidTntItem(finalAmount);
                        var leftovers = player.getInventory().addItem(tnt);
                        if (!leftovers.isEmpty()) {
                            for (ItemStack leftover : leftovers.values()) {
                                player.getWorld().dropItemNaturally(player.getLocation(), leftover);
                            }
                        }
                        player.playSound(player.getLocation(), Sound.ENTITY_TNT_PRIMED, 1.0f, 1.2f);
                        player.sendMessage(String.format(Locale.ROOT,
                            "§a[Raid] Purchased %dx Raid TNT for %,d coins! Place against enemy walls during a raid to break the base further!",
                            finalAmount, expectedPrice));
                    } else if (response.statusCode() == 402) {
                        player.sendMessage(String.format(Locale.ROOT,
                            "§c[Raid] Insufficient coins! You need %,d coins and must keep at least 1,000 coins in reserve.",
                            expectedPrice));
                    } else {
                        player.sendMessage("[Raid] Cannot purchase TNT at this time (" + response.statusCode() + ").");
                    }
                });
            });
            return;
        }
        if (args[0].equalsIgnoreCase("buy")) {
            UUID uuid = player.getUniqueId();
            String username = player.getName();
            player.sendMessage("[Raid] Purchasing Breach Charge...");
            getServer().getScheduler().runTaskAsynchronously(this, () -> {
                var response = post(internalBase + "/raid/buy",
                    "{\"uuid\":\"" + uuid + "\",\"username\":\"" + jsonEscape(username) + "\"}", requestTimeout);
                getServer().getScheduler().runTask(this, () -> {
                    if (response == null) {
                        player.sendMessage("[Raid] Server did not respond. No coins charged.");
                        return;
                    }
                    if (response.statusCode() == 200) {
                        ItemStack charge = createBreachChargeItem(1);
                        var leftovers = player.getInventory().addItem(charge);
                        if (!leftovers.isEmpty()) {
                            for (ItemStack leftover : leftovers.values()) {
                                player.getWorld().dropItemNaturally(player.getLocation(), leftover);
                            }
                        }
                        player.playSound(player.getLocation(), Sound.ITEM_ARMOR_EQUIP_NETHERITE, 1.0f, 1.0f);
                        player.sendMessage(String.format(Locale.ROOT,
                            "§a[Raid] Purchased Breach Charge for %,d coins! Right-click on an enemy private zone to arm.",
                            RaidRules.CHARGE_PRICE));
                    } else if (response.statusCode() == 402) {
                        player.sendMessage(String.format(Locale.ROOT,
                            "§c[Raid] Insufficient coins! You need %,d coins and must keep at least 1,000 coins in reserve.",
                            RaidRules.CHARGE_PRICE));
                    } else {
                        player.sendMessage("[Raid] Cannot purchase Breach Charge at this time (" + response.statusCode() + ").");
                    }
                });
            });
            return;
        }
        player.sendMessage("[Raid] Usage: /raid [buy|tnt|help]");
    }

    private void mineCommand(Player player, String[] args) {
        if (args.length == 0 || args[0].equalsIgnoreCase("enter")) {
            UUID uuid = player.getUniqueId();
            if (activeMineExpeditions.containsKey(uuid)) {
                player.sendMessage("[Mine] You are already inside the Mining Dimension!");
                return;
            }
            String username = player.getName();
            player.sendMessage("[Mine] Checking expedition clearance...");
            getServer().getScheduler().runTaskAsynchronously(this, () -> {
                var response = post(internalBase + "/mine/enter",
                    "{\"uuid\":\"" + uuid + "\",\"username\":\"" + jsonEscape(username) + "\"}", requestTimeout);
                getServer().getScheduler().runTask(this, () -> {
                    if (response == null || response.statusCode() != 200) {
                        player.sendMessage("[Mine] Cannot enter the mine right now. Try again shortly.");
                        return;
                    }
                    try {
                        var json = com.google.gson.JsonParser.parseString(response.body()).getAsJsonObject();
                        boolean allowed = json.get("allowed").getAsBoolean();
                        if (!allowed) {
                            long remaining = json.get("cooldown_remaining").getAsLong();
                            player.sendMessage("§c[Mine] The Mining Dimension is on cooldown! Available in: §e" + ExpeditionRules.formatDuration(remaining) + "§c.");
                            return;
                        }
                        World mineWorld = getServer().getWorld("mine_world");
                        if (mineWorld == null) {
                            player.sendMessage("[Mine] Mining world is not loaded. Contact operator.");
                            return;
                        }
                        Location spawn = getSafeCaveSpawn(mineWorld);
                        int spawnChunkX = spawn.getBlockX() >> 4;
                        int spawnChunkZ = spawn.getBlockZ() >> 4;
                        for (int cx = spawnChunkX - 1; cx <= spawnChunkX + 1; cx++) {
                            for (int cz = spawnChunkZ - 1; cz <= spawnChunkZ + 1; cz++) {
                                sanitizeMineChunk(mineWorld.getChunkAt(cx, cz));
                            }
                        }
                        lightMineSpawnArea(mineWorld, spawn);
                        clearHostileMobsNear(spawn, 30.0);
                        mineReturnLocations.put(uuid, player.getLocation().clone());
                        player.teleport(spawn);
                        long expires = System.currentTimeMillis() + 300_000L;
                        activeMineExpeditions.put(uuid, expires);
                        var bossBar = net.kyori.adventure.bossbar.BossBar.bossBar(
                            Component.text("⏳ [Mine Expedition] 05:00 remaining"),
                            1.0f,
                            net.kyori.adventure.bossbar.BossBar.Color.BLUE,
                            net.kyori.adventure.bossbar.BossBar.Overlay.PROGRESS
                        );
                        player.showBossBar(bossBar);
                        expeditionBossBars.put(uuid, bossBar);
                        player.playSound(player.getLocation(), org.bukkit.Sound.ENTITY_PLAYER_LEVELUP, 1.0f, 1.0f);
                        player.sendMessage("§a[Mine] Welcome to the Mining Caverns!");
                        player.sendMessage("§eYou have 5 minutes to harvest fuel crystals. Watch out for cave monsters!");
                        player.sendMessage("§7Type /mine leave at any time to return safely.");
                    } catch (Exception e) {
                        player.sendMessage("[Mine] Error reading expedition clearance.");
                    }
                });
            });
            return;
        }
        if (args[0].equalsIgnoreCase("time")) {
            UUID uuid = player.getUniqueId();
            Long expires = activeMineExpeditions.get(uuid);
            if (expires != null) {
                long left = Math.max(0, (expires - System.currentTimeMillis()) / 1000L);
                player.sendMessage("§e[Mine] Expedition time remaining: §a" + ExpeditionRules.formatDuration(left));
            } else {
                getServer().getScheduler().runTaskAsynchronously(this, () -> {
                    var response = get(internalBase + "/mine/status?uuid=" + uuid, requestTimeout);
                    getServer().getScheduler().runTask(this, () -> {
                        if (response == null || response.statusCode() != 200) {
                            player.sendMessage("[Mine] Cannot check status right now.");
                            return;
                        }
                        try {
                            var json = com.google.gson.JsonParser.parseString(response.body()).getAsJsonObject();
                            boolean allowed = json.get("allowed").getAsBoolean();
                            if (allowed) {
                                player.sendMessage("§a[Mine] Expedition is ready! Type /mine enter to start.");
                            } else {
                                long rem = json.get("cooldown_remaining").getAsLong();
                                player.sendMessage("§e[Mine] Cooldown remaining: §c" + ExpeditionRules.formatDuration(rem));
                            }
                        } catch (Exception ignored) {}
                    });
                });
            }
            return;
        }
        if (args[0].equalsIgnoreCase("leave")) {
            UUID uuid = player.getUniqueId();
            if (!activeMineExpeditions.containsKey(uuid)) {
                player.sendMessage("[Mine] You are not currently in the Mining Dimension.");
                return;
            }
            endMineExpedition(player, "You returned safely to the surface.");
            return;
        }
        if (args[0].equalsIgnoreCase("shop")) {
            minershopCommand(player, new String[]{});
            return;
        }
        player.sendMessage("[Mine] Usage: /mine [enter|time|leave|shop]");
    }

    private void openMinerShopGui(Player player) {
        UUID uuid = player.getUniqueId();
        player.sendMessage("§e[Miners] Opening Prospector Equipment shop...");
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            long coins = 0L;
            var balResp = post(internalBase + "/balance", "{\"uuid\":\"" + uuid + "\"}", requestTimeout);
            if (balResp != null && balResp.statusCode() == 200) {
                try {
                    coins = com.google.gson.JsonParser.parseString(balResp.body()).getAsJsonObject().get("coins").getAsLong();
                } catch (Exception ignored) {}
            }
            long finalCoins = coins;

            getServer().getScheduler().runTask(this, () -> {
                if (!player.isOnline()) return;

                MinerShopHolder holder = new MinerShopHolder(finalCoins);
                Inventory inv = org.bukkit.Bukkit.createInventory(holder, 27, Component.text("§8Prospector Pickaxe Workshop"));
                holder.setInventory(inv);

                ItemStack pane = new ItemStack(Material.GRAY_STAINED_GLASS_PANE);
                ItemMeta pm = pane.getItemMeta();
                if (pm != null) {
                    pm.displayName(Component.text(" "));
                    pane.setItemMeta(pm);
                }
                for (int i = 0; i < 27; i++) {
                    inv.setItem(i, pane.clone());
                }

                // Balance info header at slot 4
                ItemStack bal = new ItemStack(Material.GOLD_INGOT);
                ItemMeta bm = bal.getItemMeta();
                if (bm != null) {
                    bm.displayName(Component.text("§6§lYour Coin Balance"));
                    bm.lore(List.of(
                        Component.text(String.format(Locale.ROOT, "§7Available: §6%,d coins", finalCoins)),
                        Component.text("§7Required reserve: §e1,000 coins"),
                        Component.text("§7Pickaxes mine Fuel Crystals inside §e/mine§7!")
                    ));
                    bal.setItemMeta(bm);
                }
                inv.setItem(4, bal);

                // 4 Tiers: slots 10, 12, 14, 16
                int[] slots = {10, 12, 14, 16};
                for (int tier = 1; tier <= 4; tier++) {
                    int slot = slots[tier - 1];
                    ItemStack pickaxe = createProspectorPickaxeItem(tier);
                    long price = PickaxeRules.pickaxePrice(tier);
                    boolean canAfford = finalCoins >= price + 1000L;

                    ItemMeta meta = pickaxe.getItemMeta();
                    if (meta != null) {
                        List<Component> lore = new ArrayList<>();
                        if (meta.hasLore() && meta.lore() != null) {
                            lore.addAll(meta.lore());
                        }
                        lore.add(Component.text("§8-----------------------------"));
                        lore.add(Component.text(String.format(Locale.ROOT, "§7Price: §6%,d coins", price)));
                        lore.add(Component.text(""));
                        if (canAfford) {
                            lore.add(Component.text("§a§l▶ Click to Purchase!"));
                        } else {
                            lore.add(Component.text("§cInsufficient coins (1,000c reserve required)"));
                        }
                        meta.lore(lore);
                        pickaxe.setItemMeta(meta);
                    }
                    inv.setItem(slot, pickaxe);
                }

                player.openInventory(inv);
                player.playSound(player.getLocation(), Sound.BLOCK_ANVIL_USE, 0.8f, 1.2f);
            });
        });
    }

    private void handleMinerShopClick(Player player, MinerShopHolder holder, int slot) {
        int tier = switch (slot) {
            case 10 -> 1;
            case 12 -> 2;
            case 14 -> 3;
            case 16 -> 4;
            default -> 0;
        };
        if (tier == 0) return;

        long price = PickaxeRules.pickaxePrice(tier);
        if (holder.getCoinBalance() < price + 1000L) {
            player.playSound(player.getLocation(), Sound.ENTITY_VILLAGER_NO, 1.0f, 0.8f);
            player.sendMessage(String.format(Locale.ROOT,
                "§c[Miners] You need at least %,d coins (including 1,000c reserve) to purchase %s!",
                price + 1000L, PickaxeRules.pickaxeName(tier)));
            return;
        }

        player.closeInventory();
        minershopCommand(player, new String[]{"buy", String.valueOf(tier)});
    }

    private void minershopCommand(Player player, String[] args) {
        if (args.length == 0 || args[0].equalsIgnoreCase("gui") || args[0].equalsIgnoreCase("menu")) {
            openMinerShopGui(player);
            return;
        }
        if (args.length == 2 && args[0].equalsIgnoreCase("buy")) {
            int tier;
            try {
                tier = Integer.parseInt(args[1].trim());
                if (tier < 1 || tier > 4) throw new NumberFormatException();
            } catch (Exception e) {
                player.sendMessage("[Miners] Tier must be between 1 and 4.");
                return;
            }
            UUID uuid = player.getUniqueId();
            String username = player.getName();
            player.sendMessage("[Miners] Purchasing Tier " + tier + " Prospector Pickaxe...");
            getServer().getScheduler().runTaskAsynchronously(this, () -> {
                var response = post(internalBase + "/minershop/buy",
                    "{\"uuid\":\"" + uuid + "\",\"username\":\"" + jsonEscape(username) + "\",\"tier\":" + tier + "}", requestTimeout);
                getServer().getScheduler().runTask(this, () -> {
                    if (response == null) {
                        player.sendMessage("[Miners] Server did not respond. No coins charged.");
                        return;
                    }
                    if (response.statusCode() == 200) {
                        try {
                            var json = com.google.gson.JsonParser.parseString(response.body()).getAsJsonObject();
                            long price = json.get("price").getAsLong();
                            ItemStack pickaxe = createProspectorPickaxeItem(tier);
                            player.getInventory().addItem(pickaxe);
                            player.playSound(player.getLocation(), org.bukkit.Sound.ITEM_ARMOR_EQUIP_NETHERITE, 1.0f, 1.0f);
                            player.sendMessage(String.format(Locale.ROOT,
                                "[Miners] Purchased %s for %,d coins!",
                                PickaxeRules.pickaxeName(tier), price));
                        } catch (Exception e) {
                            player.sendMessage("[Miners] Error reading purchase response.");
                        }
                    } else if (response.statusCode() == 402) {
                        player.sendMessage("[Miners] Insufficient coins! Keep at least 1,000 coins in reserve.");
                    } else {
                        player.sendMessage("[Miners] Cannot purchase pickaxe at this time (" + response.statusCode() + ").");
                    }
                });
            });
            return;
        }
        player.sendMessage("[Miners] Usage: /minershop or /minershop buy <1-4>");
    }

    private void openCoreGui(Player player, PlacedPrivateBlock core) {
        int chunks = PrivateRules.radiusToChunks(core.radius);
        String title = "Core #" + core.blockIndex + " (" + chunks + "x" + chunks + " chunks)";
        org.bukkit.inventory.Inventory inv = org.bukkit.Bukkit.createInventory(null, 27, Component.text(title));
        updateCoreGuiItems(inv, core);
        player.openInventory(inv);
        activeCoreGuis.put(player.getUniqueId(), core);
    }

    private void updateCoreGuiItems(org.bukkit.inventory.Inventory inv, PlacedPrivateBlock core) {
        int size = PrivateRules.radiusToSize(core.radius);
        int chunks = PrivateRules.radiusToChunks(core.radius);
        ItemStack info = new ItemStack(Material.LODESTONE);
        ItemMeta im = info.getItemMeta();
        im.displayName(Component.text("§6§lProtection Core Info"));
        im.lore(List.of(
            Component.text("§7Owner: §f" + core.ownerName),
            Component.text(String.format(Locale.ROOT, "§7Active Size: §e%dx%d blocks §7(%dx%d chunks, Full Height)", size, size, chunks, chunks)),
            Component.text("§7Active Tier: §bTier " + core.fuelTier),
            Component.text("§7Total Fuel: " + (core.fuelSeconds > 0 ? "§a" + ExpeditionRules.formatDuration(core.fuelSeconds) : "§c00:00 (Inactive)")),
            Component.text("§7Fuel Queue:"),
            Component.text("  §d• Tier 4: §f" + ExpeditionRules.formatDuration(core.tier4Seconds) + (core.tier4Seconds > 0 ? " §a[ACTIVE]" : "")),
            Component.text("  §c• Tier 3: §f" + ExpeditionRules.formatDuration(core.tier3Seconds) + (core.tier4Seconds == 0 && core.tier3Seconds > 0 ? " §a[ACTIVE]" : "")),
            Component.text("  §b• Tier 2: §f" + ExpeditionRules.formatDuration(core.tier2Seconds) + (core.tier4Seconds == 0 && core.tier3Seconds == 0 && core.tier2Seconds > 0 ? " §a[ACTIVE]" : "")),
            Component.text("  §6• Tier 1: §f" + ExpeditionRules.formatDuration(core.tier1Seconds) + (core.tier4Seconds == 0 && core.tier3Seconds == 0 && core.tier2Seconds == 0 && core.tier1Seconds > 0 ? " §a[ACTIVE]" : "")),
            Component.text("§7Trusted Members: §f" + (core.members.isEmpty() ? "None" : core.members.size() + " players"))
        ));
        info.setItemMeta(im);
        inv.setItem(4, info);

        // Tier 1: Ember Shard (Slot 10)
        ItemStack t1 = new ItemStack(Material.RAW_COPPER);
        ItemMeta t1m = t1.getItemMeta();
        t1m.displayName(Component.text("§6§lTier 1: Ember Shard (2x2 Chunks)"));
        boolean t1Active = core.tier4Seconds == 0 && core.tier3Seconds == 0 && core.tier2Seconds == 0 && core.tier1Seconds > 0;
        t1m.lore(List.of(
            Component.text("§7Queued Time: §f" + ExpeditionRules.formatDuration(core.tier1Seconds) + (t1Active ? " §a[ACTIVE]" : (core.tier1Seconds > 0 ? " §e[QUEUED]" : " §8[EMPTY]"))),
            Component.text("§7Stored Crystals: §e" + (core.tier1Seconds / 7200) + " §7(+" + (core.tier1Seconds % 7200) + "s leftover)"),
            Component.text(""),
            Component.text("§e[Click] §7Withdraw 1 Crystal (-2h)"),
            Component.text("§e[Shift-Click] §7Withdraw All Crystals")
        ));
        t1.setItemMeta(t1m);
        inv.setItem(10, t1);

        // Tier 2: Cobalt Crystal (Slot 11)
        ItemStack t2 = new ItemStack(Material.PRISMARINE_CRYSTALS);
        ItemMeta t2m = t2.getItemMeta();
        t2m.displayName(Component.text("§b§lTier 2: Cobalt Crystal (5x5 Chunks)"));
        boolean t2Active = core.tier4Seconds == 0 && core.tier3Seconds == 0 && core.tier2Seconds > 0;
        t2m.lore(List.of(
            Component.text("§7Queued Time: §f" + ExpeditionRules.formatDuration(core.tier2Seconds) + (t2Active ? " §a[ACTIVE]" : (core.tier2Seconds > 0 ? " §e[QUEUED]" : " §8[EMPTY]"))),
            Component.text("§7Stored Crystals: §e" + (core.tier2Seconds / 10800) + " §7(+" + (core.tier2Seconds % 10800) + "s leftover)"),
            Component.text(""),
            Component.text("§e[Click] §7Withdraw 1 Crystal (-3h)"),
            Component.text("§e[Shift-Click] §7Withdraw All Crystals")
        ));
        t2.setItemMeta(t2m);
        inv.setItem(11, t2);

        // Tier 3: Crimson Core (Slot 12)
        ItemStack t3 = new ItemStack(Material.REDSTONE);
        ItemMeta t3m = t3.getItemMeta();
        t3m.displayName(Component.text("§c§lTier 3: Crimson Core (10x10 Chunks)"));
        boolean t3Active = core.tier4Seconds == 0 && core.tier3Seconds > 0;
        t3m.lore(List.of(
            Component.text("§7Queued Time: §f" + ExpeditionRules.formatDuration(core.tier3Seconds) + (t3Active ? " §a[ACTIVE]" : (core.tier3Seconds > 0 ? " §e[QUEUED]" : " §8[EMPTY]"))),
            Component.text("§7Stored Crystals: §e" + (core.tier3Seconds / 14400) + " §7(+" + (core.tier3Seconds % 14400) + "s leftover)"),
            Component.text(""),
            Component.text("§e[Click] §7Withdraw 1 Crystal (-4h)"),
            Component.text("§e[Shift-Click] §7Withdraw All Crystals")
        ));
        t3.setItemMeta(t3m);
        inv.setItem(12, t3);

        // Tier 4: Astral Void Crystal (Slot 13)
        ItemStack t4 = new ItemStack(Material.ECHO_SHARD);
        ItemMeta t4m = t4.getItemMeta();
        t4m.displayName(Component.text("§d§lTier 4: Astral Void Crystal (16x16 Chunks)"));
        boolean t4Active = core.tier4Seconds > 0;
        t4m.lore(List.of(
            Component.text("§7Queued Time: §f" + ExpeditionRules.formatDuration(core.tier4Seconds) + (t4Active ? " §a[ACTIVE]" : (core.tier4Seconds > 0 ? " §e[QUEUED]" : " §8[EMPTY]"))),
            Component.text("§7Stored Crystals: §e" + (core.tier4Seconds / 21600) + " §7(+" + (core.tier4Seconds % 21600) + "s leftover)"),
            Component.text(""),
            Component.text("§e[Click] §7Withdraw 1 Crystal (-6h)"),
            Component.text("§e[Shift-Click] §7Withdraw All Crystals")
        ));
        t4.setItemMeta(t4m);
        inv.setItem(13, t4);

        // Deposit Hopper (Slot 15)
        ItemStack fuelSlot = new ItemStack(Material.HOPPER);
        ItemMeta fm = fuelSlot.getItemMeta();
        fm.displayName(Component.text("§e§lDeposit Fuel Crystals"));
        fm.lore(List.of(
            Component.text("§7• Click with a fuel crystal on your cursor"),
            Component.text("§7• Or click this hopper to use one from inventory"),
            Component.text("§7• Or shift-click any fuel crystal in your inventory"),
            Component.text(""),
            Component.text("§7Available Tiers:"),
            Component.text("§6  - Ember Shard (T1): §7+2h (2x2 chunks / 32x32)"),
            Component.text("§b  - Cobalt Crystal (T2): §7+3h (5x5 chunks / 80x80)"),
            Component.text("§c  - Crimson Core (T3): §7+4h (10x10 chunks / 160x160)"),
            Component.text("§d  - Astral Void Crystal (T4): §7+6h (16x16 chunks / 256x256)")
        ));
        fuelSlot.setItemMeta(fm);
        inv.setItem(15, fuelSlot);

        ItemStack dismantle = new ItemStack(Material.BARRIER);
        ItemMeta dm = dismantle.getItemMeta();
        dm.displayName(Component.text("§c§lDismantle Core"));
        dm.lore(List.of(
            Component.text("§7Click to safely dismantle this core"),
            Component.text("§7and return it to your inventory.")
        ));
        dismantle.setItemMeta(dm);
        inv.setItem(22, dismantle);
    }

    private int getFuelCrystalTier(ItemStack item) {
        if (item == null || !item.hasItemMeta()) return 0;
        var pdc = item.getItemMeta().getPersistentDataContainer();
        var key = new NamespacedKey(this, "fuel_tier");
        if (pdc.has(key, org.bukkit.persistence.PersistentDataType.INTEGER)) {
            Integer val = pdc.get(key, org.bukkit.persistence.PersistentDataType.INTEGER);
            return val != null ? val : 0;
        }
        return 0;
    }

    private void applyFuelDeposit(Player player, PlacedPrivateBlock core, int fuelTier, org.bukkit.inventory.Inventory topInv) {
        long addedSeconds = FuelRules.fuelDuration(fuelTier);
        core.addFuel(fuelTier, addedSeconds);
        syncPrivateBlockAsync(core);
        player.playSound(player.getLocation(), org.bukkit.Sound.BLOCK_BEACON_POWER_SELECT, 1.0f, 1.0f);
        int size = PrivateRules.radiusToSize(core.radius);
        int chunks = PrivateRules.radiusToChunks(core.radius);
        player.sendMessage(String.format(Locale.ROOT,
            "§a[Private] Deposited Tier %d fuel (+%s)! Current active tier: Tier %d (%dx%d chunks) | Total remaining: %s",
            fuelTier, ExpeditionRules.formatDuration(addedSeconds), core.fuelTier, chunks, chunks, ExpeditionRules.formatDuration(core.fuelSeconds)));
        if (topInv != null) {
            updateCoreGuiItems(topInv, core);
        }
    }

    private Location getSafeCaveSpawn(World world) {
        return getRandomCaveSpawn(world);
    }

    private Location getRandomCaveSpawn(World world) {
        java.util.concurrent.ThreadLocalRandom rng = java.util.concurrent.ThreadLocalRandom.current();

        for (int attempt = 0; attempt < 12; attempt++) {
            // Pick a random direction and distance (250 to 4000 blocks from origin)
            double angle = rng.nextDouble() * 2.0 * Math.PI;
            double distance = 250.0 + rng.nextDouble() * 3750.0;
            int centerX = (int) (distance * Math.cos(angle));
            int centerZ = (int) (distance * Math.sin(angle));

            // Sample random positions in this area
            for (int sample = 0; sample < 16; sample++) {
                int testX = centerX + rng.nextInt(-48, 49);
                int testZ = centerZ + rng.nextInt(-48, 49);

                world.getChunkAt(testX >> 4, testZ >> 4);

                int surfaceY = world.getHighestBlockYAt(testX, testZ);
                int startY = Math.min(surfaceY - 14, 45);
                int endY = Math.max(world.getMinHeight() + 8, -55);

                for (int y = startY; y >= endY; y--) {
                    Location candidate = new Location(world, testX + 0.5, y, testZ + 0.5);
                    if (isSafeCaveSpot(candidate)) {
                        return candidate;
                    }
                }
            }
        }

        // Fallback: If no open cavern was found after 12 attempts across the world,
        // carve out a safe underground grotto at a new random location.
        double angle = rng.nextDouble() * 2.0 * Math.PI;
        double distance = 400.0 + rng.nextDouble() * 2600.0;
        int cx = (int) (distance * Math.cos(angle));
        int cz = (int) (distance * Math.sin(angle));
        int cy = 12;

        world.getChunkAt(cx >> 4, cz >> 4);
        for (int dx = -3; dx <= 3; dx++) {
            for (int dz = -3; dz <= 3; dz++) {
                world.getBlockAt(cx + dx, cy - 1, cz + dz).setType(Material.DEEPSLATE);
                for (int dy = 0; dy <= 3; dy++) {
                    world.getBlockAt(cx + dx, cy + dy, cz + dz).setType(Material.CAVE_AIR);
                }
                world.getBlockAt(cx + dx, cy + 4, cz + dz).setType(Material.STONE);
            }
        }
        world.getBlockAt(cx - 2, cy + 1, cz).setType(Material.TORCH);
        world.getBlockAt(cx + 2, cy + 1, cz).setType(Material.TORCH);
        world.getBlockAt(cx, cy + 1, cz - 2).setType(Material.TORCH);
        world.getBlockAt(cx, cy + 1, cz + 2).setType(Material.TORCH);

        return new Location(world, cx + 0.5, cy, cz + 0.5);
    }

    private boolean isSafeCaveSpot(Location loc) {
        if (loc == null || loc.getWorld() == null) return false;
        World w = loc.getWorld();
        int x = loc.getBlockX();
        int y = loc.getBlockY();
        int z = loc.getBlockZ();
        if (y <= w.getMinHeight() + 5 || y >= w.getMaxHeight() - 10) return false;

        Block feet = w.getBlockAt(x, y, z);
        Block head = w.getBlockAt(x, y + 1, z);
        Block ground = w.getBlockAt(x, y - 1, z);

        boolean feetAir = feet.getType().isAir() || feet.getType() == Material.CAVE_AIR;
        boolean headAir = head.getType().isAir() || head.getType() == Material.CAVE_AIR;
        if (!feetAir || !headAir) return false;

        Material gType = ground.getType();
        if (!gType.isSolid() || gType == Material.LAVA || gType == Material.WATER || gType == Material.BEDROCK || gType == Material.FIRE) {
            return false;
        }

        // Check 1 block perimeter for lava or fire hazards
        for (int dx = -1; dx <= 1; dx++) {
            for (int dz = -1; dz <= 1; dz++) {
                Material m = w.getBlockAt(x + dx, y, z + dz).getType();
                Material below = w.getBlockAt(x + dx, y - 1, z + dz).getType();
                if (m == Material.LAVA || below == Material.LAVA || m == Material.FIRE) {
                    return false;
                }
            }
        }

        return true;
    }

    private void lightMineSpawnArea(World world, Location spawn) {
        if (world == null || spawn == null) return;
        int sx = spawn.getBlockX();
        int sy = spawn.getBlockY();
        int sz = spawn.getBlockZ();

        for (int dx = -5; dx <= 5; dx += 2) {
            for (int dz = -5; dz <= 5; dz += 2) {
                int x = sx + dx;
                int z = sz + dz;
                for (int y = sy - 2; y <= sy + 4; y++) {
                    Block block = world.getBlockAt(x, y, z);
                    Block below = world.getBlockAt(x, y - 1, z);
                    if ((block.getType().isAir() || block.getType() == Material.CAVE_AIR)
                        && below.getType().isSolid()
                        && below.getType() != Material.LAVA
                        && below.getType() != Material.TORCH
                        && below.getType() != Material.LANTERN) {
                        block.setType(Material.TORCH);
                        break;
                    }
                }
            }
        }
    }

    private void clearHostileMobsNear(Location loc, double radius) {
        if (loc == null || loc.getWorld() == null) return;
        for (org.bukkit.entity.Entity entity : loc.getWorld().getNearbyEntities(loc, radius, radius, radius)) {
            if (entity instanceof org.bukkit.entity.Monster || entity instanceof org.bukkit.entity.Slime || entity instanceof org.bukkit.entity.Phantom) {
                entity.remove();
            }
        }
    }

    private void sanitizeMineChunk(Chunk chunk) {
        if (chunk == null || !chunk.getWorld().getName().equals("mine_world")) return;
        var pdc = chunk.getPersistentDataContainer();
        var key = new NamespacedKey(this, "ores_sanitized");
        if (pdc.has(key, org.bukkit.persistence.PersistentDataType.BYTE)) {
            return;
        }
        pdc.set(key, org.bukkit.persistence.PersistentDataType.BYTE, (byte) 1);

        int minHeight = Math.max(chunk.getWorld().getMinHeight(), -64);
        int maxHeight = Math.min(chunk.getWorld().getMaxHeight(), 80);
        for (int x = 0; x < 16; x++) {
            for (int z = 0; z < 16; z++) {
                for (int y = minHeight; y <= maxHeight; y++) {
                    Block b = chunk.getBlock(x, y, z);
                    Material type = b.getType();
                    if (FuelRules.isNonFuelOre(type.name())) {
                        boolean deep = type.name().contains("DEEPSLATE") || y < 0;
                        b.setType(deep ? Material.DEEPSLATE : Material.STONE, false);
                    }
                }
            }
        }
    }

    @EventHandler(priority = EventPriority.NORMAL)
    public void onPrivateBlockBreak(BlockBreakEvent event) {
        Player player = event.getPlayer();
        Block block = event.getBlock();
        String worldName = block.getWorld().getName();

        if (worldName.equals("mine_world")) {
            int oreTier = FuelRules.oreTier(block.getType().name());
            if (oreTier > 0) {
                ItemStack hand = player.getInventory().getItemInMainHand();
                int pickaxeTier = 0;
                if (hand != null && hand.hasItemMeta()) {
                    var pdc = hand.getItemMeta().getPersistentDataContainer();
                    var key = new NamespacedKey(this, "prospector_tier");
                    if (pdc.has(key, org.bukkit.persistence.PersistentDataType.INTEGER)) {
                        pickaxeTier = pdc.get(key, org.bukkit.persistence.PersistentDataType.INTEGER);
                    }
                }
                if (!PickaxeRules.canMineTier(pickaxeTier, oreTier)) {
                    event.setCancelled(true);
                    player.sendMessage("§c[Mine] You need a " + PickaxeRules.pickaxeName(oreTier) + " to extract this fuel crystal!");
                    player.playSound(player.getLocation(), org.bukkit.Sound.BLOCK_ANVIL_LAND, 0.5f, 0.5f);
                    return;
                }
                event.setCancelled(true);
                Material orig = block.getType();
                block.setType(Material.BEDROCK);
                block.getWorld().dropItemNaturally(block.getLocation().add(0.5, 0.5, 0.5), createFuelCrystalItem(oreTier));
                block.getWorld().playSound(block.getLocation(), org.bukkit.Sound.BLOCK_AMETHYST_CLUSTER_BREAK, 1.0f, 1.0f);
                long cooldownMs = switch (oreTier) {
                    case 1 -> 30_000L;
                    case 2 -> 60_000L;
                    case 3 -> 90_000L;
                    case 4 -> 120_000L;
                    default -> 30_000L;
                };
                regeneratingNodes.put(block.getLocation(), new RegeneratingOreNode(orig, System.currentTimeMillis() + cooldownMs));
                return;
            }
            if (block.getType() == Material.BEDROCK) {
                event.setCancelled(true);
                return;
            }
            // Allow breaking to navigate the cavern, but drop no items and give no exp!
            event.setDropItems(false);
            event.setExpToDrop(0);
            return;
        }

        PlacedPrivateBlock core = getPlacedCoreAt(block.getLocation());
        if (core != null) {
            if (!core.ownerUuid.equals(player.getUniqueId())) {
                event.setCancelled(true);
                player.sendMessage("§c[Protected] Only the owner (" + core.ownerName + ") can dismantle this protection core!");
                return;
            }
            event.setCancelled(true);
            block.setType(Material.AIR);
            placedPrivateBlocks.remove(blockKey(block.getLocation()));
            core.placed = false;
            syncPrivateBlockAsync(core);
            var leftovers = player.getInventory().addItem(createProtectionCoreItem(core.blockIndex));
            if (!leftovers.isEmpty()) {
                for (ItemStack leftover : leftovers.values()) {
                    block.getWorld().dropItemNaturally(block.getLocation().add(0.5, 0.5, 0.5), leftover);
                }
            }
            player.sendMessage("§a[Private] Protection core dismantled and returned to inventory.");
            return;
        }

        PlacedPrivateBlock pb = getProtectingBlock(block.getLocation());
        if (pb != null && !canAccessZone(player.getUniqueId(), pb)) {
            event.setCancelled(true);
            player.sendActionBar(Component.text("§c[Protected] Zone owned by " + pb.ownerName + "!"));
        }
    }

    @EventHandler(priority = EventPriority.NORMAL)
    public void onPrivateBlockPlace(BlockPlaceEvent event) {
        Player player = event.getPlayer();
        Block block = event.getBlockPlaced();
        String worldName = block.getWorld().getName();

        if (worldName.equals("mine_world")) {
            event.setCancelled(true);
            player.sendMessage("§c[Mine] You cannot place blocks in the Mining Dimension!");
            return;
        }

        ItemStack item = event.getItemInHand();
        if (item != null && item.hasItemMeta()) {
            var pdc = item.getItemMeta().getPersistentDataContainer();
            if (pdc.has(new NamespacedKey(this, "breach_charge"), org.bukkit.persistence.PersistentDataType.BYTE)) {
                event.setCancelled(true);
                return;
            }
            var key = new NamespacedKey(this, "private_core");
            if (pdc.has(key, org.bukkit.persistence.PersistentDataType.INTEGER)) {
                int blockIndex = pdc.get(key, org.bukkit.persistence.PersistentDataType.INTEGER);
                Location loc = block.getLocation();

                PlacedPrivateBlock overlapping = getProtectingBlock(loc);
                if (overlapping != null && !overlapping.ownerUuid.equals(player.getUniqueId()) && !isSameClan(player.getUniqueId(), overlapping.ownerUuid)) {
                    event.setCancelled(true);
                    player.sendMessage("§c[Private] You cannot place a private block inside " + overlapping.ownerName + "'s protected zone!");
                    return;
                }

                PlacedPrivateBlock alreadyPlaced = getPlacedBlockByUserAndIndex(player.getUniqueId(), blockIndex);
                if (alreadyPlaced != null && alreadyPlaced.placed) {
                    World oldW = getServer().getWorld(alreadyPlaced.world);
                    if (oldW != null && oldW.getBlockAt(alreadyPlaced.x, alreadyPlaced.y, alreadyPlaced.z).getType() == Material.LODESTONE) {
                        event.setCancelled(true);
                        player.sendMessage(String.format(Locale.ROOT,
                            "§c[Private] Your Protection Core #%d is already placed at %s (%d, %d, %d)! Dismantle it first before placing another.",
                            blockIndex, alreadyPlaced.world, alreadyPlaced.x, alreadyPlaced.y, alreadyPlaced.z));
                        return;
                    } else {
                        placedPrivateBlocks.remove(alreadyPlaced.world + ":" + alreadyPlaced.x + ":" + alreadyPlaced.y + ":" + alreadyPlaced.z);
                    }
                }

                PlacedPrivateBlock pb = new PlacedPrivateBlock(
                    UUID.randomUUID().toString(),
                    player.getUniqueId(),
                    player.getName(),
                    blockIndex,
                    loc.getWorld().getName(),
                    loc.getBlockX(),
                    loc.getBlockY(),
                    loc.getBlockZ(),
                    true,
                    16,
                    0L,
                    1,
                    new ArrayList<>()
                );
                placedPrivateBlocks.put(blockKey(loc), pb);
                syncPrivateBlockAsync(pb);
                questProgress(player, "starter_private", 8, 1);
                block.getWorld().spawnParticle(Particle.TOTEM_OF_UNDYING, loc.clone().add(0.5, 0.5, 0.5), 25);
                player.playSound(loc, org.bukkit.Sound.BLOCK_BEACON_ACTIVATE, 1.0f, 1.0f);
                player.sendMessage("§6[Private] Protection core placed!");
                player.sendMessage("§eRight-click the core to deposit fuel crystals and expand your zone.");
                return;
            }
        }

        PlacedPrivateBlock pb = getProtectingBlock(block.getLocation());
        if (pb != null && !canAccessZone(player.getUniqueId(), pb)) {
            if (activeBreaches.containsKey(pb.id)) {
                if (isRaidTnt(item)) {
                    activeRaidTntBlocks.put(blockKey(block.getLocation()), pb.id);
                    return;
                } else if (block.getType() == Material.TNT) {
                    event.setCancelled(true);
                    player.sendMessage("§c[Raid] Only Raid TNT can be used to breach enemy bases! Use /raid tnt to get Raid TNT.");
                    return;
                }
            }
            event.setCancelled(true);
            player.sendActionBar(Component.text("§c[Protected] Zone owned by " + pb.ownerName + "! Cannot build or place blocks without a raid."));
        }
    }

    @EventHandler(priority = EventPriority.NORMAL)
    public void onPrivateInteract(PlayerInteractEvent event) {
        if (event.getAction() != org.bukkit.event.block.Action.RIGHT_CLICK_BLOCK) return;
        if (event.getHand() != org.bukkit.inventory.EquipmentSlot.HAND) return;
        Block block = event.getClickedBlock();
        if (block == null) return;
        Player player = event.getPlayer();

        if (block.getType() == Material.TNT && activeRaidTntBlocks.containsKey(blockKey(block.getLocation()))) {
            ItemStack tool = player.getInventory().getItem(event.getHand());
            if (tool != null && (tool.getType() == Material.FLINT_AND_STEEL || tool.getType() == Material.FIRE_CHARGE)) {
                String zoneId = activeRaidTntBlocks.remove(blockKey(block.getLocation()));
                Location tntLoc = block.getLocation().clone().add(0.5, 0.0, 0.5);
                block.setType(Material.AIR);
                TNTPrimed primed = (TNTPrimed) block.getWorld().spawn(tntLoc, TNTPrimed.class);
                primed.setSource(player);
                primed.setFuseTicks(80);
                primed.getPersistentDataContainer().set(raidTntKey, org.bukkit.persistence.PersistentDataType.BYTE, (byte) 1);
                if (zoneId != null) {
                    primed.getPersistentDataContainer().set(breachZoneKey, org.bukkit.persistence.PersistentDataType.STRING, zoneId);
                }
                block.getWorld().playSound(tntLoc, Sound.ENTITY_TNT_PRIMED, 1.0f, 1.0f);
                if (tool.getType() == Material.FLINT_AND_STEEL) {
                    Damageable dmg = (Damageable) tool.getItemMeta();
                    if (dmg != null) {
                        dmg.setDamage(dmg.getDamage() + 1);
                        tool.setItemMeta(dmg);
                    }
                }
                event.setCancelled(true);
                return;
            }
        }

        ItemStack hand = player.getInventory().getItemInMainHand();
        if (hand != null && hand.hasItemMeta()) {
            var pdc = hand.getItemMeta().getPersistentDataContainer();
            if (pdc.has(new NamespacedKey(this, "breach_charge"), org.bukkit.persistence.PersistentDataType.BYTE)) {
                event.setCancelled(true);
                PlacedPrivateBlock targetZone = getProtectingBlock(block.getLocation());
                if (targetZone == null) {
                    player.sendMessage("§c[Raid] Breach Charges can only be used on enemy protected zones!");
                    return;
                }
                if (targetZone.ownerUuid.equals(player.getUniqueId()) || targetZone.members.contains(player.getUniqueId()) || isSameClan(player.getUniqueId(), targetZone.ownerUuid)) {
                    player.sendMessage("§c[Raid] You cannot breach your own or your teammates' base!");
                    return;
                }
                if (activeBreaches.containsKey(targetZone.id)) {
                    player.sendMessage("§c[Raid] This zone is already breached!");
                    return;
                }
                boolean alreadyPrimed = primedCharges.stream().anyMatch(pc -> pc.zoneId.equals(targetZone.id));
                if (alreadyPrimed) {
                    player.sendMessage("§c[Raid] A breach charge is already ticking on this zone!");
                    return;
                }

                hand.setAmount(hand.getAmount() - 1);
                Location armLoc = block.getLocation().clone().add(0.5, 0.5, 0.5);
                primedCharges.add(new PrimedCharge(targetZone.id, armLoc, player.getUniqueId(), player.getName(), RaidRules.FUSE_SECONDS));
                block.getWorld().playSound(armLoc, Sound.ENTITY_TNT_PRIMED, 1.0f, 1.0f);
                player.sendMessage("§c§l[Raid] Breach Charge armed! Detonation in " + RaidRules.FUSE_SECONDS + " seconds! Stand back!");

                Player owner = getServer().getPlayer(targetZone.ownerUuid);
                if (owner != null && owner.isOnline()) {
                    owner.sendMessage(String.format(Locale.ROOT,
                        "§4§l[RAID ALERT] §cYour base at (%d, %d, %d) is being breached by %s! 10 seconds until breach!",
                        targetZone.x, targetZone.y, targetZone.z, player.getName()));
                    owner.playSound(owner.getLocation(), Sound.ENTITY_WITHER_SPAWN, 1.0f, 0.5f);
                }
                for (UUID memberUuid : targetZone.members) {
                    Player member = getServer().getPlayer(memberUuid);
                    if (member != null && member.isOnline()) {
                        member.sendMessage(String.format(Locale.ROOT,
                            "§4§l[RAID ALERT] §cYour team base at (%d, %d, %d) is being breached by %s! 10 seconds until breach!",
                            targetZone.x, targetZone.y, targetZone.z, player.getName()));
                    }
                }
                return;
            }
        }

        PlacedPrivateBlock core = getPlacedCoreAt(block.getLocation());
        if (core != null) {
            event.setCancelled(true);
            if (core.ownerUuid.equals(player.getUniqueId())) {
                openCoreGui(player, core);
            } else {
                int size = PrivateRules.radiusToSize(core.radius);
                int chunks = PrivateRules.radiusToChunks(core.radius);
                player.sendMessage(String.format(Locale.ROOT,
                    "§6[Protected] §7Owner: §f%s §7| Size: §e%dx%d blocks (%dx%d chunks, Full Height) §7| Protection: %s",
                    core.ownerName, size, size, chunks, chunks, core.fuelSeconds > 0 ? "§aActive" : "§cDormant (No Fuel)"));
            }
            return;
        }

        Material type = block.getType();
        String typeName = type.name();
        boolean isProtectedInteractable = PrivateRules.isProtectedInteractable(typeName);

        if (isProtectedInteractable) {
            PlacedPrivateBlock pb = getProtectingBlock(block.getLocation());
            if (pb != null && !canAccessZone(player.getUniqueId(), pb)) {
                if (activeBreaches.containsKey(pb.id)) {
                    if (PrivateRules.canOpenInRaid(typeName)) {
                        // In raid: only chests can be opened!
                        return;
                    } else {
                        event.setCancelled(true);
                        player.sendActionBar(Component.text("§c[Raid] In a raid you can only open chests (doors and trapdoors remain locked)!"));
                        return;
                    }
                }
                event.setCancelled(true);
                player.sendActionBar(Component.text("§c[Protected] Cannot open doors or containers without an active raid!"));
            }
        }
    }

    @EventHandler
    public void onPrivateGuiClick(InventoryClickEvent event) {
        if (!(event.getWhoClicked() instanceof Player player)) return;
        PlacedPrivateBlock core = activeCoreGuis.get(player.getUniqueId());
        if (core == null) return;

        var clickedInv = event.getClickedInventory();
        var topInv = event.getView().getTopInventory();
        var bottomInv = event.getView().getBottomInventory();

        if (clickedInv == bottomInv) {
            if (event.isShiftClick()) {
                ItemStack item = event.getCurrentItem();
                int fuelTier = getFuelCrystalTier(item);
                if (fuelTier > 0) {
                    event.setCancelled(true);
                    item.setAmount(item.getAmount() - 1);
                    applyFuelDeposit(player, core, fuelTier, topInv);
                    return;
                }
            }
            return;
        }

        if (clickedInv == topInv) {
            event.setCancelled(true);
            int slot = event.getSlot();

            if (slot >= 10 && slot <= 13) {
                int tier = slot - 9; // 10 -> 1, 11 -> 2, 12 -> 3, 13 -> 4
                long duration = FuelRules.fuelDuration(tier);
                long currentSeconds = core.getTierSeconds(tier);
                if (currentSeconds < duration) {
                    player.sendMessage("§c[Private] Not enough Tier " + tier + " fuel to withdraw a crystal (requires " + ExpeditionRules.formatDuration(duration) + ").");
                    player.playSound(player.getLocation(), org.bukkit.Sound.BLOCK_NOTE_BLOCK_BASS, 1.0f, 0.5f);
                    return;
                }

                int count = event.isShiftClick() ? (int)(currentSeconds / duration) : 1;
                if (core.withdrawFuel(tier, count)) {
                    syncPrivateBlockAsync(core);
                    for (int i = 0; i < count; i++) {
                        var leftovers = player.getInventory().addItem(createFuelCrystalItem(tier));
                        for (ItemStack leftover : leftovers.values()) {
                            player.getWorld().dropItemNaturally(player.getLocation(), leftover);
                        }
                    }
                    player.playSound(player.getLocation(), org.bukkit.Sound.ENTITY_ITEM_PICKUP, 1.0f, 1.2f);
                    player.sendMessage(String.format(Locale.ROOT,
                        "§a[Private] Withdrew %d Tier %d crystal%s! Remaining tier fuel: %s",
                        count, tier, (count > 1 ? "s" : ""), ExpeditionRules.formatDuration(core.getTierSeconds(tier))));
                    updateCoreGuiItems(topInv, core);
                }
                return;
            }

            if (slot == 15) {
                ItemStack cursor = event.getCursor();
                int fuelTier = getFuelCrystalTier(cursor);
                if (fuelTier > 0) {
                    cursor.setAmount(cursor.getAmount() - 1);
                    applyFuelDeposit(player, core, fuelTier, topInv);
                    return;
                }

                var inv = player.getInventory();
                for (int i = 0; i < inv.getSize(); i++) {
                    ItemStack it = inv.getItem(i);
                    int itTier = getFuelCrystalTier(it);
                    if (itTier > 0) {
                        it.setAmount(it.getAmount() - 1);
                        applyFuelDeposit(player, core, itTier, topInv);
                        return;
                    }
                }

                player.sendMessage("§e[Private] Pick up a fuel crystal (Ember, Cobalt, Crimson, Void) or have one in inventory, then click the hopper!");
                player.playSound(player.getLocation(), org.bukkit.Sound.BLOCK_NOTE_BLOCK_BASS, 1.0f, 0.5f);
            } else if (slot == 22) {
                player.closeInventory();
                Location loc = new Location(getServer().getWorld(core.world), core.x, core.y, core.z);
                if (loc.getBlock().getType() == Material.LODESTONE) {
                    loc.getBlock().setType(Material.AIR);
                }
                placedPrivateBlocks.remove(blockKey(loc));
                core.placed = false;
                syncPrivateBlockAsync(core);
                var leftovers = player.getInventory().addItem(createProtectionCoreItem(core.blockIndex));
                if (!leftovers.isEmpty()) {
                    for (ItemStack leftover : leftovers.values()) {
                        player.getWorld().dropItemNaturally(player.getLocation(), leftover);
                    }
                }
                player.sendMessage("§a[Private] Protection core dismantled and returned to inventory.");
            }
        }
    }

    @EventHandler
    public void onPrivateGuiDrag(org.bukkit.event.inventory.InventoryDragEvent event) {
        if (!(event.getWhoClicked() instanceof Player player)) return;
        PlacedPrivateBlock core = activeCoreGuis.get(player.getUniqueId());
        if (core == null) return;
        for (int rawSlot : event.getRawSlots()) {
            if (rawSlot < 27) {
                event.setCancelled(true);
                return;
            }
        }
    }

    @EventHandler
    public void onMineChunkLoad(org.bukkit.event.world.ChunkLoadEvent event) {
        if (event.getWorld().getName().equals("mine_world")) {
            sanitizeMineChunk(event.getChunk());
        }
    }

    @EventHandler(priority = EventPriority.NORMAL)
    public void onMineBucketEmpty(org.bukkit.event.player.PlayerBucketEmptyEvent event) {
        if (event.getBlock().getWorld().getName().equals("mine_world")) {
            event.setCancelled(true);
            event.getPlayer().sendActionBar(Component.text("§c[Mine] You cannot place liquids in the Mining Dimension!"));
        }
    }

    private UUID resolveCreeperTrigger(Creeper creeper) {
        if (creeper.getTarget() instanceof Player p) {
            return p.getUniqueId();
        }

        try {
            if (creeperTriggerKey != null) {
                var pdc = creeper.getPersistentDataContainer();
                if (pdc.has(creeperTriggerKey, org.bukkit.persistence.PersistentDataType.STRING)) {
                    String stored = pdc.get(creeperTriggerKey, org.bukkit.persistence.PersistentDataType.STRING);
                    if (stored != null && !stored.isBlank()) {
                        return UUID.fromString(stored);
                    }
                }
            }
        } catch (Exception ignored) {}

        double closestDistSq = 49.0;
        UUID nearest = null;
        for (Player p : creeper.getWorld().getPlayers()) {
            if (!p.isOnline() || p.isDead()) continue;
            double dSq = p.getLocation().distanceSquared(creeper.getLocation());
            if (dSq <= closestDistSq) {
                closestDistSq = dSq;
                nearest = p.getUniqueId();
            }
        }
        return nearest;
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onCreeperTarget(EntityTargetLivingEntityEvent event) {
        if (event.getEntity() instanceof Creeper creeper && creeperTriggerKey != null) {
            if (event.getTarget() instanceof Player player) {
                creeper.getPersistentDataContainer().set(creeperTriggerKey, org.bukkit.persistence.PersistentDataType.STRING, player.getUniqueId().toString());
            }
        }
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onCreeperDamage(EntityDamageByEntityEvent event) {
        if (event.getEntity() instanceof Creeper creeper && creeperTriggerKey != null) {
            Player damager = null;
            if (event.getDamager() instanceof Player p) {
                damager = p;
            } else if (event.getDamager() instanceof Projectile proj && proj.getShooter() instanceof Player p) {
                damager = p;
            }
            if (damager != null) {
                creeper.getPersistentDataContainer().set(creeperTriggerKey, org.bukkit.persistence.PersistentDataType.STRING, damager.getUniqueId().toString());
            }
        }
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onCreeperIgnite(PlayerInteractEntityEvent event) {
        if (event.getRightClicked() instanceof Creeper creeper && creeperTriggerKey != null) {
            ItemStack item = event.getPlayer().getInventory().getItem(event.getHand());
            if (item != null && (item.getType() == Material.FLINT_AND_STEEL || item.getType() == Material.FIRE_CHARGE)) {
                creeper.getPersistentDataContainer().set(creeperTriggerKey, org.bukkit.persistence.PersistentDataType.STRING, event.getPlayer().getUniqueId().toString());
            }
        }
    }

    @EventHandler(priority = EventPriority.NORMAL)
    public void onPrivateEntityExplode(EntityExplodeEvent event) {
        if (event.getLocation().getWorld().getName().equals("mine_world")) {
            event.blockList().clear();
            return;
        }

        event.blockList().removeIf(b -> getPlacedCoreAt(b.getLocation()) != null);

        if (event.getEntity() instanceof Creeper creeper) {
            UUID triggerUuid = resolveCreeperTrigger(creeper);

            event.blockList().removeIf(b -> {
                PlacedPrivateBlock pb = getProtectingBlock(b.getLocation());
                if (pb == null) return false;

                boolean canDamage = PrivateRules.canExplosionDamageZone(triggerUuid, pb.ownerUuid, pb.members);
                return !canDamage;
            });
            return;
        }

        // Trigger chain reaction on adjacent placed Raid TNT blocks
        for (Block b : event.blockList()) {
            String key = blockKey(b.getLocation());
            if (activeRaidTntBlocks.containsKey(key)) {
                String chainZone = activeRaidTntBlocks.remove(key);
                Location chainLoc = b.getLocation().clone().add(0.5, 0.0, 0.5);
                b.setType(Material.AIR);
                TNTPrimed chainTnt = (TNTPrimed) b.getWorld().spawn(chainLoc, TNTPrimed.class);
                chainTnt.setFuseTicks(15);
                chainTnt.getPersistentDataContainer().set(raidTntKey, org.bukkit.persistence.PersistentDataType.BYTE, (byte) 1);
                if (chainZone != null) {
                    chainTnt.getPersistentDataContainer().set(breachZoneKey, org.bukkit.persistence.PersistentDataType.STRING, chainZone);
                }
            }
        }

        if (event.getEntity() instanceof TNTPrimed tnt) {
            boolean isRaidTnt = tnt.getPersistentDataContainer().has(raidTntKey, org.bukkit.persistence.PersistentDataType.BYTE);
            String zoneId = tnt.getPersistentDataContainer().get(breachZoneKey, org.bukkit.persistence.PersistentDataType.STRING);
            ActiveBreach breach = (zoneId != null) ? activeBreaches.get(zoneId) : null;
            UUID sourcePlayerUuid = (tnt.getSource() instanceof Player p) ? p.getUniqueId() : null;

            event.blockList().removeIf(b -> {
                PlacedPrivateBlock pb = getProtectingBlock(b.getLocation());
                if (pb == null) return false;

                boolean isMember = sourcePlayerUuid != null && canAccessZone(sourcePlayerUuid, pb);
                boolean isZoneUnderRaid = activeBreaches.containsKey(pb.id);
                boolean canDamage = PrivateRules.canTntDamageBlock(b.getType().name(), isMember, isRaidTnt, isZoneUnderRaid);

                if (canDamage) {
                    if (!isMember && breach != null) {
                        breach.restoredBlocks.add(new BreachedBlock(b.getLocation(), b.getBlockData().clone()));
                    }
                    return false;
                }
                return true;
            });
            return;
        }

        UUID sourcePlayerUuid = null;
        final UUID finalSourceUuid = sourcePlayerUuid;
        event.blockList().removeIf(b -> {
            PlacedPrivateBlock pb = getProtectingBlock(b.getLocation());
            if (pb == null) return false;

            boolean canDamage = PrivateRules.canExplosionDamageZone(finalSourceUuid, pb.ownerUuid, pb.members);
            return !canDamage;
        });
    }

    @EventHandler(priority = EventPriority.NORMAL)
    public void onPrivateBlockExplode(BlockExplodeEvent event) {
        if (event.getBlock().getWorld().getName().equals("mine_world")) {
            event.blockList().clear();
            return;
        }
        event.blockList().removeIf(b -> getPlacedCoreAt(b.getLocation()) != null || getProtectingBlock(b.getLocation()) != null);
    }

    @EventHandler(priority = EventPriority.NORMAL)
    public void onPrivateHangingBreakByEntity(HangingBreakByEntityEvent event) {
        PlacedPrivateBlock pb = getProtectingBlock(event.getEntity().getLocation());
        if (pb == null) return;

        if (event.getRemover() instanceof Creeper creeper) {
            UUID trigger = resolveCreeperTrigger(creeper);
            if (!PrivateRules.canExplosionDamageZone(trigger, pb.ownerUuid, pb.members)) {
                event.setCancelled(true);
            }
        } else if (event.getRemover() instanceof TNTPrimed tnt) {
            UUID source = (tnt.getSource() instanceof Player p) ? p.getUniqueId() : null;
            if (!PrivateRules.canExplosionDamageZone(source, pb.ownerUuid, pb.members)) {
                event.setCancelled(true);
            }
        }
    }

    @EventHandler(priority = EventPriority.NORMAL)
    public void onPrivateArmorStandDamage(EntityDamageByEntityEvent event) {
        if (event.getEntity() instanceof ArmorStand || event.getEntity() instanceof ItemFrame) {
            PlacedPrivateBlock pb = getProtectingBlock(event.getEntity().getLocation());
            if (pb == null) return;

            if (event.getDamager() instanceof Creeper creeper) {
                UUID trigger = resolveCreeperTrigger(creeper);
                if (!PrivateRules.canExplosionDamageZone(trigger, pb.ownerUuid, pb.members)) {
                    event.setCancelled(true);
                }
            } else if (event.getDamager() instanceof TNTPrimed tnt) {
                UUID source = (tnt.getSource() instanceof Player p) ? p.getUniqueId() : null;
                if (!PrivateRules.canExplosionDamageZone(source, pb.ownerUuid, pb.members)) {
                    event.setCancelled(true);
                }
            }
        }
    }

    @EventHandler(priority = EventPriority.NORMAL)
    public void onPrivatePistonExtend(org.bukkit.event.block.BlockPistonExtendEvent event) {
        for (Block b : event.getBlocks()) {
            if (getPlacedCoreAt(b.getLocation()) != null) {
                event.setCancelled(true);
                return;
            }
        }
    }

    @EventHandler(priority = EventPriority.NORMAL)
    public void onPrivatePistonRetract(org.bukkit.event.block.BlockPistonRetractEvent event) {
        for (Block b : event.getBlocks()) {
            if (getPlacedCoreAt(b.getLocation()) != null) {
                event.setCancelled(true);
                return;
            }
        }
    }

    @EventHandler
    public void onPrivateGuiClose(org.bukkit.event.inventory.InventoryCloseEvent event) {
        activeCoreGuis.remove(event.getPlayer().getUniqueId());
    }

    @EventHandler
    public void onMinePlayerQuit(PlayerQuitEvent event) {
        Player player = event.getPlayer();
        if (activeMineExpeditions.containsKey(player.getUniqueId())) {
            endMineExpedition(player, null);
        }
    }

    @EventHandler(priority = EventPriority.NORMAL)
    public void onPlayerItemDamage(org.bukkit.event.player.PlayerItemDamageEvent event) {
        if (event.getPlayer().getWorld().getName().equals("mine_world")) {
            event.setCancelled(true);
        }
    }

    // --- Live Web & In-Game Chat Integration ---

    private final java.util.concurrent.ConcurrentLinkedQueue<ChatSyncItem> outgoingChatQueue = new java.util.concurrent.ConcurrentLinkedQueue<>();

    record ChatSyncItem(String senderName, String uuid, String text) {}

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onPlayerChat(io.papermc.paper.event.player.AsyncChatEvent event) {
        if (event.getPlayer() == null) return;
        String text = net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer.plainText().serialize(event.message()).trim();
        if (text.isEmpty() || text.length() > 256) return;
        String username = event.getPlayer().getName();
        String uuid = event.getPlayer().getUniqueId().toString();
        if (outgoingChatQueue.size() < 200) {
            outgoingChatQueue.add(new ChatSyncItem(username, uuid, text));
        }
    }

    private void syncChat() {
        if (internalBase == null || internalBase.isBlank() || serviceToken == null || serviceToken.isBlank()) return;
        List<ChatSyncItem> batch = new ArrayList<>();
        ChatSyncItem item;
        while ((item = outgoingChatQueue.poll()) != null && batch.size() < 50) {
            batch.add(item);
        }

        com.google.gson.JsonObject root = new com.google.gson.JsonObject();
        com.google.gson.JsonArray incomingArr = new com.google.gson.JsonArray();
        for (ChatSyncItem c : batch) {
            com.google.gson.JsonObject obj = new com.google.gson.JsonObject();
            obj.addProperty("sender_name", c.senderName());
            obj.addProperty("uuid", c.uuid());
            obj.addProperty("text", c.text());
            incomingArr.add(obj);
        }
        root.add("incoming", incomingArr);

        try {
            HttpResponse<String> response = post(internalBase + "/chat/sync", root.toString(), requestTimeout);
            if (response != null && response.statusCode() == 200) {
                com.google.gson.JsonObject resObj = com.google.gson.JsonParser.parseString(response.body()).getAsJsonObject();
                if (resObj.has("outgoing")) {
                    com.google.gson.JsonArray outgoingArr = resObj.getAsJsonArray("outgoing");
                    if (outgoingArr.size() > 0) {
                        getServer().getScheduler().runTask(this, () -> {
                            for (com.google.gson.JsonElement el : outgoingArr) {
                                com.google.gson.JsonObject m = el.getAsJsonObject();
                                String senderName = m.get("sender_name").getAsString();
                                String text = m.get("text").getAsString();
                                Component comp = Component.text("§8[§bWeb§8] §f" + senderName + "§7: §f" + text);
                                getServer().broadcast(comp);
                            }
                        });
                    }
                }
            } else {
                if (outgoingChatQueue.size() < 100) {
                    outgoingChatQueue.addAll(batch);
                }
            }
        } catch (Exception e) {
            if (outgoingChatQueue.size() < 100) {
                outgoingChatQueue.addAll(batch);
            }
        }
    }

    // --- Extended Web Admin Panel: Metrics, Console, Moderation ----------------

    record AdminOnlinePlayerDto(
        String uuid,
        String username,
        int ping,
        String world,
        int x,
        int y,
        int z,
        double health,
        boolean is_muted
    ) {}

    record CommandResult(String requestId, List<String> output, boolean success) {}
    record MuteInfo(String username, String reason, long expiresAt) {}

    private final ConcurrentLinkedQueue<String> adminConsoleLogQueue = new ConcurrentLinkedQueue<>();
    private final ConcurrentLinkedQueue<CommandResult> completedCommandsQueue = new ConcurrentLinkedQueue<>();
    private final Map<String, MuteInfo> activeMutes = new ConcurrentHashMap<>();
    private Handler adminLogHandler;
    private org.apache.logging.log4j.core.Appender adminLog4jAppender;
    private final List<String> commandOutputStream = new ArrayList<>();
    private volatile Thread commandOutputThread;
    private volatile boolean adminSyncStartedLogged;
    private volatile String lastAdminSyncWarning = "";
    private volatile long lastAdminSyncWarningAt;

    /**
     * Nothing else reports a failing console/metrics sync: the dashboard simply stays
     * empty, so the operator cannot tell a dead panel from a rejected payload. Log the
     * reason, but at most once a minute per distinct reason so a down panel cannot
     * flood the server log.
     */
    private void warnAdminSync(String detail) {
        long now = System.currentTimeMillis();
        if (detail.equals(lastAdminSyncWarning) && now - lastAdminSyncWarningAt < 60_000L) return;
        lastAdminSyncWarning = detail;
        lastAdminSyncWarningAt = now;
        getLogger().warning("[Admin] Console and metrics sync failed: " + detail);
    }

    private void setupAdminLogCapture() {
        // Paper and its forks log through Log4j2. A handler on the JUL root logger only
        // ever sees what plugins log through java.util.logging, so the terminal showed
        // almost nothing; attach to Log4j2 instead, which carries the whole server
        // stream. The JUL handler stays as the fallback for a server without Log4j.
        if (!attachServerLogCapture()) {
            attachJulLogCapture();
        }
    }

    private void queueAdminLog(String line) {
        if (line == null) return;
        String cleaned = stripAnsi(line).strip();
        if (cleaned.isEmpty()) return;
        while (adminConsoleLogQueue.size() >= 500) {
            adminConsoleLogQueue.poll();
        }
        adminConsoleLogQueue.offer(cleaned);
    }

    private static final java.util.regex.Pattern ANSI_ESCAPE =
        java.util.regex.Pattern.compile("\u001B\\[[;\\d]*m");

    /** The terminal renders plain text, so colour codes would only show up as noise. */
    private static String stripAnsi(String text) {
        return ANSI_ESCAPE.matcher(text).replaceAll("");
    }

    /**
     * Copies the server's own Log4j2 stream into the web console terminal. Everything
     * is guarded: a missing or unreadable logging backend must leave the game running
     * and simply fall back to the JUL handler.
     */
    private boolean attachServerLogCapture() {
        try {
            org.apache.logging.log4j.core.LoggerContext context =
                (org.apache.logging.log4j.core.LoggerContext) org.apache.logging.log4j.LogManager.getContext(false);
            org.apache.logging.log4j.core.config.Configuration config = context.getConfiguration();
            AdminConsoleAppender appender = new AdminConsoleAppender(this);
            appender.start();
            config.addAppender(appender);
            config.getRootLogger().addAppender(appender, org.apache.logging.log4j.Level.ALL, null);
            context.updateLoggers();
            adminLog4jAppender = appender;
            return true;
        } catch (Throwable error) {
            getLogger().warning("Could not attach the server log stream: " + error);
            return false;
        }
    }

    /** The server's log stream, formatted as the console terminal shows it. */
    private static final class AdminConsoleAppender
        extends org.apache.logging.log4j.core.appender.AbstractAppender {
        private final LinkBridgePlugin plugin;

        AdminConsoleAppender(LinkBridgePlugin plugin) {
            super("LinkBridgeAdminConsole", null, null, false);
            this.plugin = plugin;
        }

        @Override
        public void append(org.apache.logging.log4j.core.LogEvent event) {
            if (event == null || event.getMessage() == null) return;
            String message = event.getMessage().getFormattedMessage();
            if (message == null || message.isBlank()) return;
            plugin.queueAdminLog("[" + event.getLevel().name() + "] " + message);
            plugin.captureCommandOutput(message);
        }
    }

    /** Lines a running dashboard command prints, collected on its own thread. */
    private void captureCommandOutput(String message) {
        if (commandOutputThread != Thread.currentThread()) return;
        synchronized (commandOutputStream) {
            commandOutputStream.add(stripAnsi(message));
        }
    }

    private void attachJulLogCapture() {
        try {
            adminLogHandler = new Handler() {
                @Override
                public void publish(LogRecord record) {
                    if (record == null || record.getMessage() == null) return;
                    String msg = record.getMessage();
                    if (record.getParameters() != null && record.getParameters().length > 0 && msg.contains("{0}")) {
                        try {
                            msg = java.text.MessageFormat.format(msg, record.getParameters());
                        } catch (Exception ignored) {}
                    }
                    String level = record.getLevel() != null ? record.getLevel().getName() : "INFO";
                    queueAdminLog("[" + level + "] " + msg);
                    captureCommandOutput(msg);
                }

                @Override
                public void flush() {}

                @Override
                public void close() throws SecurityException {}
            };
            java.util.logging.Logger.getLogger("").addHandler(adminLogHandler);
        } catch (Exception e) {
            getLogger().warning("Could not attach admin console log handler: " + e.getMessage());
        }
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onPlayerChatModeration(io.papermc.paper.event.player.AsyncChatEvent event) {
        if (event.getPlayer() == null) return;
        Player player = event.getPlayer();
        String nameKey = player.getName().toLowerCase(Locale.ROOT);
        MuteInfo mute = activeMutes.get(nameKey);
        if (mute != null) {
            if (mute.expiresAt() > 0 && System.currentTimeMillis() > mute.expiresAt()) {
                activeMutes.remove(nameKey);
            } else {
                event.setCancelled(true);
                String timeLeft = mute.expiresAt() > 0 ? formatMuteDuration(mute.expiresAt() - System.currentTimeMillis()) : "Permanent";
                player.sendMessage(Component.text("§c[Moderation] You are muted (" + timeLeft + "). Reason: §f" + mute.reason()));
            }
        }
    }

    private static String formatMuteDuration(long millis) {
        if (millis <= 0) return "0s";
        long seconds = millis / 1000;
        long h = seconds / 3600;
        long m = (seconds % 3600) / 60;
        long s = seconds % 60;
        if (h > 0) return String.format(Locale.ROOT, "%dh %dm %ds", h, m, s);
        if (m > 0) return String.format(Locale.ROOT, "%dm %ds", m, s);
        return String.format(Locale.ROOT, "%ds", s);
    }

    private void syncAdmin() {
        if (internalBase == null || internalBase.isBlank() || serviceToken == null || serviceToken.isBlank()) {
            warnAdminSync("the panel address or service token is not configured");
            return;
        }
        if (!adminSyncStartedLogged) {
            adminSyncStartedLogged = true;
            getLogger().info("[Admin] Console and metrics sync started.");
        }

        // Collect TPS. The panel's dashboard draws the classic three windows, so send
        // those however many samples this fork exposes (Purpur reports four).
        double[] tpsArr = org.bukkit.Bukkit.getTPS();
        com.google.gson.JsonArray tpsJson = new com.google.gson.JsonArray();
        for (int i = 0; i < Math.min(3, tpsArr.length); i++) {
            tpsJson.add(Math.round(tpsArr[i] * 100.0) / 100.0);
        }

        // Collect RAM
        Runtime rt = Runtime.getRuntime();
        long totalMb = rt.totalMemory() / (1024 * 1024);
        long freeMb = rt.freeMemory() / (1024 * 1024);
        long maxMb = rt.maxMemory() / (1024 * 1024);
        long usedMb = Math.max(0, totalMb - freeMb);

        // Collect online players
        com.google.gson.JsonArray playersJson = new com.google.gson.JsonArray();
        for (Player p : getServer().getOnlinePlayers()) {
            Location loc = p.getLocation();
            com.google.gson.JsonObject pObj = new com.google.gson.JsonObject();
            pObj.addProperty("uuid", p.getUniqueId().toString());
            pObj.addProperty("username", p.getName());
            pObj.addProperty("ping", p.getPing());
            pObj.addProperty("world", loc.getWorld() != null ? loc.getWorld().getName() : "world");
            pObj.addProperty("x", loc.getBlockX());
            pObj.addProperty("y", loc.getBlockY());
            pObj.addProperty("z", loc.getBlockZ());
            pObj.addProperty("health", Math.round(p.getHealth() * 10.0) / 10.0);
            pObj.addProperty("is_muted", activeMutes.containsKey(p.getName().toLowerCase(Locale.ROOT)));
            boolean isSleeping = p.isSleeping();
            pObj.addProperty("is_sleeping", isSleeping);
            String playerStatus = isSleeping ? "sleeping" : (p.isDead() || p.getHealth() <= 0.0 ? "dead" : "in_game");
            pObj.addProperty("status", playerStatus);
            playersJson.add(pObj);
        }

        // Drain console logs
        List<String> logBatch = new ArrayList<>();
        String logLine;
        while ((logLine = adminConsoleLogQueue.poll()) != null && logBatch.size() < 100) {
            logBatch.add(logLine);
        }
        com.google.gson.JsonArray logsJson = new com.google.gson.JsonArray();
        for (String l : logBatch) {
            logsJson.add(l);
        }

        // Drain command results
        List<CommandResult> resultBatch = new ArrayList<>();
        CommandResult cr;
        while ((cr = completedCommandsQueue.poll()) != null && resultBatch.size() < 25) {
            resultBatch.add(cr);
        }
        com.google.gson.JsonArray resultsJson = new com.google.gson.JsonArray();
        for (CommandResult r : resultBatch) {
            com.google.gson.JsonObject rObj = new com.google.gson.JsonObject();
            rObj.addProperty("request_id", r.requestId());
            rObj.addProperty("success", r.success());
            com.google.gson.JsonArray outArr = new com.google.gson.JsonArray();
            for (String out : r.output()) {
                outArr.add(out);
            }
            rObj.add("output", outArr);
            resultsJson.add(rObj);
        }

        com.google.gson.JsonObject root = new com.google.gson.JsonObject();
        root.add("tps", tpsJson);
        root.addProperty("ram_used_mb", usedMb);
        root.addProperty("ram_total_mb", totalMb);
        root.addProperty("ram_max_mb", maxMb);
        root.addProperty("server_version", getServer().getName() + " " + getServer().getMinecraftVersion());
        root.add("online_players", playersJson);
        root.add("console_logs", logsJson);
        root.add("command_results", resultsJson);

        try {
            HttpResponse<String> response = post(internalBase + "/admin/sync", root.toString(), requestTimeout);
            if (response != null && response.statusCode() == 200) {
                com.google.gson.JsonObject resObj = com.google.gson.JsonParser.parseString(response.body()).getAsJsonObject();
                if (resObj.has("pending_commands") || resObj.has("pending_moderations")) {
                    com.google.gson.JsonArray commandsArr = resObj.has("pending_commands") ? resObj.getAsJsonArray("pending_commands") : new com.google.gson.JsonArray();
                    com.google.gson.JsonArray moderationsArr = resObj.has("pending_moderations") ? resObj.getAsJsonArray("pending_moderations") : new com.google.gson.JsonArray();

                    if (commandsArr.size() > 0 || moderationsArr.size() > 0) {
                        getServer().getScheduler().runTask(this, () -> {
                            for (com.google.gson.JsonElement el : commandsArr) {
                                com.google.gson.JsonObject cmdObj = el.getAsJsonObject();
                                String reqId = cmdObj.get("request_id").getAsString();
                                String cmd = cmdObj.get("command").getAsString();
                                executeConsoleCommand(reqId, cmd);
                            }
                            for (com.google.gson.JsonElement el : moderationsArr) {
                                com.google.gson.JsonObject modObj = el.getAsJsonObject();
                                String modId = modObj.get("id").getAsString();
                                String action = modObj.get("action").getAsString();
                                String targetUser = modObj.get("target_username").getAsString();
                                String targetUuid = modObj.has("target_uuid") && !modObj.get("target_uuid").isJsonNull() ? modObj.get("target_uuid").getAsString() : null;
                                String reason = modObj.has("reason") ? modObj.get("reason").getAsString() : "";
                                Long durSec = modObj.has("duration_seconds") && !modObj.get("duration_seconds").isJsonNull() ? modObj.get("duration_seconds").getAsLong() : null;
                                executeModerationAction(modId, action, targetUuid, targetUser, reason, durSec);
                            }
                        });
                    }
                }
            } else {
                String detail = response == null
                    ? "the panel could not be reached"
                    : "the panel answered HTTP " + response.statusCode()
                        + (response.body() == null || response.body().isBlank() ? "" : ": " + abbreviate(response.body()))
                        // A rejected payload is only diagnosable next to what was sent.
                        + (response.statusCode() == 400 ? " | sent " + abbreviate(root.toString()) : "");
                warnAdminSync(detail);
                for (CommandResult r : resultBatch) {
                    completedCommandsQueue.offer(r);
                }
            }
        } catch (Exception e) {
            warnAdminSync("the payload could not be built or sent: " + e);
            for (CommandResult r : resultBatch) {
                completedCommandsQueue.offer(r);
            }
        }
    }

    private static String abbreviate(String text) {
        String single = text.replace('\n', ' ').strip();
        return single.length() <= 200 ? single : single.substring(0, 200) + "…";
    }

    /**
     * Runs a command the dashboard queued and collects what it printed. The console
     * sender is used as it is: a hand-made CommandSender breaks Bukkit's vanilla
     * wrappers ("Unhandled exception executing … in VanillaCommandWrapper") and
     * missed most output. Everything the command prints reaches the server log, and
     * the log capture keeps the lines emitted on this thread while it runs.
     */
    private void executeConsoleCommand(String requestId, String commandLine) {
        List<String> output = new ArrayList<>();
        synchronized (commandOutputStream) {
            commandOutputStream.clear();
        }
        commandOutputThread = Thread.currentThread();
        boolean success;
        try {
            success = getServer().dispatchCommand(getServer().getConsoleSender(), commandLine);
        } catch (Exception e) {
            output.add("Error executing command: " + e);
            completedCommandsQueue.offer(new CommandResult(requestId, output, false));
            return;
        } finally {
            commandOutputThread = null;
        }
        synchronized (commandOutputStream) {
            output.addAll(commandOutputStream);
            commandOutputStream.clear();
        }
        if (output.isEmpty()) {
            output.add(success ? "Command executed." : "Command unknown or failed.");
        }
        completedCommandsQueue.offer(new CommandResult(requestId, output, success));
    }

    private void executeModerationAction(String id, String action, String targetUuid, String targetUsername, String reason, Long durationSeconds) {
        if (action == null || targetUsername == null) return;
        String cleanName = targetUsername.trim();
        String lowerName = cleanName.toLowerCase(Locale.ROOT);

        switch (action.toLowerCase(Locale.ROOT)) {
            case "kick" -> {
                Player p = getServer().getPlayerExact(cleanName);
                if (p != null && p.isOnline()) {
                    p.kick(Component.text("§cKicked by Administrator:\n§f" + (reason.isBlank() ? "Kicked by administrator" : reason)));
                }
            }
            case "ban" -> {
                Date expires = (durationSeconds != null && durationSeconds > 0)
                    ? new Date(System.currentTimeMillis() + durationSeconds * 1000L)
                    : null;
                try {
                    getServer().getBanList(org.bukkit.BanList.Type.NAME).addBan(cleanName, reason, expires, "WebAdmin");
                } catch (Throwable t) {
                    getServer().dispatchCommand(getServer().getConsoleSender(), "ban " + cleanName + " " + reason);
                }
                Player p = getServer().getPlayerExact(cleanName);
                if (p != null && p.isOnline()) {
                    String expStr = expires != null ? " until " + expires : " permanently";
                    p.kick(Component.text("§cYou are banned" + expStr + "!\n§fReason: " + (reason.isBlank() ? "Banned by administrator" : reason)));
                }
            }
            case "unban" -> {
                try {
                    getServer().getBanList(org.bukkit.BanList.Type.NAME).pardon(cleanName);
                } catch (Throwable t) {
                    getServer().dispatchCommand(getServer().getConsoleSender(), "pardon " + cleanName);
                }
            }
            case "mute" -> {
                long expiresAt = (durationSeconds != null && durationSeconds > 0)
                    ? System.currentTimeMillis() + durationSeconds * 1000L
                    : 0L;
                activeMutes.put(lowerName, new MuteInfo(cleanName, reason, expiresAt));
                Player p = getServer().getPlayerExact(cleanName);
                if (p != null && p.isOnline()) {
                    String durStr = expiresAt > 0 ? (" for " + durationSeconds + "s") : " permanently";
                    p.sendMessage(Component.text("§c[Muted] You have been muted" + durStr + ". Reason: §f" + reason));
                }
            }
            case "unmute" -> {
                activeMutes.remove(lowerName);
                Player p = getServer().getPlayerExact(cleanName);
                if (p != null && p.isOnline()) {
                    p.sendMessage(Component.text("§a[Unmuted] You have been unmuted."));
                }
            }
        }
    }

    // --- Clan & Factions System ---------------------------------------------

    public record ClanHome(String world, double x, double y, double z, float yaw, float pitch) {}
    public record ClanCacheEntry(
        UUID id,
        String tag,
        String name,
        UUID leaderUuid,
        long coins,
        ClanHome home,
        Set<UUID> members,
        Set<String> allies,
        Set<String> truces,
        Set<String> wars
    ) {}

    private final Map<UUID, UUID> playerToClanId = new ConcurrentHashMap<>();
    private final Map<UUID, ClanCacheEntry> clansById = new ConcurrentHashMap<>();
    private final Map<String, UUID> clanTagToId = new ConcurrentHashMap<>();

    public boolean isSameClan(UUID u1, UUID u2) {
        if (u1 == null || u2 == null) return false;
        UUID c1 = playerToClanId.get(u1);
        UUID c2 = playerToClanId.get(u2);
        return c1 != null && c1.equals(c2);
    }

    public boolean canAccessZone(UUID playerUuid, PlacedPrivateBlock pb) {
        if (pb == null) return true;
        if (PrivateRules.canAccess(playerUuid, pb.ownerUuid, pb.members)) return true;
        return isSameClan(playerUuid, pb.ownerUuid);
    }

    private void syncClans() {
        if (internalBase == null || internalBase.isBlank() || serviceToken == null || serviceToken.isBlank()) return;
        try {
            HttpResponse<String> resp = get(internalBase + "/clans/sync", requestTimeout);
            if (resp != null && resp.statusCode() == 200) {
                com.google.gson.JsonArray arr = com.google.gson.JsonParser.parseString(resp.body()).getAsJsonArray();
                Map<UUID, UUID> newPlayerClan = new HashMap<>();
                Map<UUID, ClanCacheEntry> newClans = new HashMap<>();
                Map<String, UUID> newTagToId = new HashMap<>();

                for (com.google.gson.JsonElement el : arr) {
                    com.google.gson.JsonObject c = el.getAsJsonObject();
                    UUID clanId = UUID.fromString(c.get("id").getAsString());
                    String tag = c.get("tag").getAsString();
                    String name = c.get("name").getAsString();
                    UUID leaderUuid = UUID.fromString(c.get("leader_uuid").getAsString());
                    long coins = c.get("coins").getAsLong();

                    ClanHome home = null;
                    if (c.has("home") && !c.get("home").isJsonNull()) {
                        var h = c.getAsJsonObject("home");
                        home = new ClanHome(
                            h.get("world").getAsString(),
                            h.get("x").getAsDouble(),
                            h.get("y").getAsDouble(),
                            h.get("z").getAsDouble(),
                            h.get("yaw").getAsFloat(),
                            h.get("pitch").getAsFloat()
                        );
                    }

                    Set<UUID> members = new HashSet<>();
                    if (c.has("members")) {
                        for (var m : c.getAsJsonArray("members")) {
                            UUID mUuid = UUID.fromString(m.getAsJsonObject().get("uuid").getAsString());
                            members.add(mUuid);
                            newPlayerClan.put(mUuid, clanId);
                        }
                    }

                    Set<String> allies = new HashSet<>();
                    if (c.has("allies")) {
                        for (var a : c.getAsJsonArray("allies")) allies.add(a.getAsString());
                    }
                    Set<String> truces = new HashSet<>();
                    if (c.has("truces")) {
                        for (var t : c.getAsJsonArray("truces")) truces.add(t.getAsString());
                    }
                    Set<String> wars = new HashSet<>();
                    if (c.has("wars")) {
                        for (var w : c.getAsJsonArray("wars")) wars.add(w.getAsString());
                    }

                    ClanCacheEntry entry = new ClanCacheEntry(
                        clanId, tag, name, leaderUuid, coins, home, members, allies, truces, wars
                    );
                    newClans.put(clanId, entry);
                    newTagToId.put(tag.toUpperCase(Locale.ROOT), clanId);
                }

                playerToClanId.clear();
                playerToClanId.putAll(newPlayerClan);
                clansById.clear();
                clansById.putAll(newClans);
                clanTagToId.clear();
                clanTagToId.putAll(newTagToId);
            }
        } catch (Exception e) {
            getLogger().warning("[Clan] Failed to sync clans: " + e.getMessage());
        }
    }

    private void handleClanCommand(Player player, String[] args) {
        if (args.length == 0 || args[0].equalsIgnoreCase("help")) {
            player.sendMessage("§6§l==== [Clan & Factions Commands] ====");
            player.sendMessage("§e/clan create <tag> <name> §7- Create a new clan");
            player.sendMessage("§e/clan invite <player> §7- Invite an ally to your clan");
            player.sendMessage("§e/clan join <tag> §7- Accept an invitation and join a clan");
            player.sendMessage("§e/clan leave §7- Leave your current clan");
            player.sendMessage("§e/clan sethome §7- Set your clan's home point");
            player.sendMessage("§e/clan home §7- Teleport to your clan home");
            player.sendMessage("§e/clan bank [deposit|withdraw <amount>] §7- Clan treasury");
            player.sendMessage("§e/clan info [tag] §7- View clan members, allies and status");
            player.sendMessage("§e/clan ally|enemy|neutral <tag> §7- Set diplomatic relations");
            player.sendMessage("§e/clan disband §7- Disband your clan (Leader only)");
            return;
        }

        String sub = args[0].toLowerCase(Locale.ROOT);
        UUID playerUuid = player.getUniqueId();
        String playerName = player.getName();

        switch (sub) {
            case "create" -> {
                if (args.length < 3) {
                    player.sendMessage("§c[Clan] Usage: /clan create <TAG> <Name>");
                    return;
                }
                String tag = args[1].toUpperCase(Locale.ROOT);
                StringBuilder nameB = new StringBuilder();
                for (int i = 2; i < args.length; i++) {
                    if (i > 2) nameB.append(" ");
                    nameB.append(args[i]);
                }
                String name = nameB.toString();

                var body = new com.google.gson.JsonObject();
                body.addProperty("action", "create");
                body.addProperty("player_uuid", playerUuid.toString());
                body.addProperty("player_username", playerName);
                body.addProperty("tag", tag);
                body.addProperty("name", name);

                getServer().getScheduler().runTaskAsynchronously(this, () -> {
                    var resp = post(internalBase + "/clans/action", body.toString(), requestTimeout);
                    handleClanActionResponse(player, resp);
                    syncClans();
                });
            }

            case "invite" -> {
                if (args.length < 2) {
                    player.sendMessage("§c[Clan] Usage: /clan invite <player>");
                    return;
                }
                String target = args[1];
                var body = new com.google.gson.JsonObject();
                body.addProperty("action", "invite");
                body.addProperty("player_uuid", playerUuid.toString());
                body.addProperty("player_username", playerName);
                body.addProperty("target_username", target);

                getServer().getScheduler().runTaskAsynchronously(this, () -> {
                    var resp = post(internalBase + "/clans/action", body.toString(), requestTimeout);
                    handleClanActionResponse(player, resp);

                    Player targetPlayer = getServer().getPlayerExact(target);
                    if (targetPlayer != null && targetPlayer.isOnline()) {
                        UUID clanId = playerToClanId.get(playerUuid);
                        ClanCacheEntry c = clanId != null ? clansById.get(clanId) : null;
                        String tag = c != null ? c.tag : "clan";
                        targetPlayer.sendMessage(Component.text(
                            String.format(Locale.ROOT, "§6[Clan] §eYou were invited to join §b[%s]§e! Type §a/clan join %s§e or accept on the website.", tag, tag)
                        ));
                        targetPlayer.playSound(targetPlayer.getLocation(), Sound.ENTITY_EXPERIENCE_ORB_PICKUP, 1.0f, 1.0f);
                    }
                });
            }

            case "join", "accept" -> {
                if (args.length < 2) {
                    player.sendMessage("§c[Clan] Usage: /clan join <TAG>");
                    return;
                }
                String tag = args[1].toUpperCase(Locale.ROOT);
                var body = new com.google.gson.JsonObject();
                body.addProperty("action", "join");
                body.addProperty("player_uuid", playerUuid.toString());
                body.addProperty("player_username", playerName);
                body.addProperty("target_tag", tag);

                getServer().getScheduler().runTaskAsynchronously(this, () -> {
                    var resp = post(internalBase + "/clans/action", body.toString(), requestTimeout);
                    handleClanActionResponse(player, resp);
                    syncClans();
                });
            }

            case "leave" -> {
                var body = new com.google.gson.JsonObject();
                body.addProperty("action", "leave");
                body.addProperty("player_uuid", playerUuid.toString());
                body.addProperty("player_username", playerName);

                getServer().getScheduler().runTaskAsynchronously(this, () -> {
                    var resp = post(internalBase + "/clans/action", body.toString(), requestTimeout);
                    handleClanActionResponse(player, resp);
                    syncClans();
                });
            }

            case "sethome" -> {
                Location loc = player.getLocation();
                var body = new com.google.gson.JsonObject();
                body.addProperty("action", "sethome");
                body.addProperty("player_uuid", playerUuid.toString());
                body.addProperty("player_username", playerName);
                body.addProperty("home_world", loc.getWorld().getName());
                body.addProperty("home_x", loc.getX());
                body.addProperty("home_y", loc.getY());
                body.addProperty("home_z", loc.getZ());
                body.addProperty("home_yaw", loc.getYaw());
                body.addProperty("home_pitch", loc.getPitch());

                getServer().getScheduler().runTaskAsynchronously(this, () -> {
                    var resp = post(internalBase + "/clans/action", body.toString(), requestTimeout);
                    handleClanActionResponse(player, resp);
                    syncClans();
                });
            }

            case "home" -> {
                UUID clanId = playerToClanId.get(playerUuid);
                if (clanId == null) {
                    player.sendMessage("§c[Clan] You are not in a clan.");
                    return;
                }
                ClanCacheEntry clan = clansById.get(clanId);
                if (clan == null || clan.home == null) {
                    player.sendMessage("§c[Clan] Your clan has not set a home point yet! Leaders can use /clan sethome.");
                    return;
                }
                ClanHome h = clan.home;
                World w = getServer().getWorld(h.world);
                if (w == null) {
                    player.sendMessage("§c[Clan] Home world is currently unavailable.");
                    return;
                }
                Location targetLoc = new Location(w, h.x, h.y, h.z, h.yaw, h.pitch);
                player.sendMessage("§a[Clan] Teleporting to clan home...");
                player.teleport(targetLoc);
                player.playSound(targetLoc, Sound.ITEM_CHORUS_FRUIT_TELEPORT, 1.0f, 1.0f);
                player.spawnParticle(Particle.PORTAL, targetLoc.clone().add(0, 1, 0), 30);
            }

            case "bank", "bal", "balance" -> {
                UUID clanId = playerToClanId.get(playerUuid);
                if (clanId == null) {
                    player.sendMessage("§c[Clan] You are not in a clan.");
                    return;
                }
                if (args.length >= 3 && (args[1].equalsIgnoreCase("deposit") || args[1].equalsIgnoreCase("withdraw"))) {
                    boolean isDeposit = args[1].equalsIgnoreCase("deposit");
                    long amount;
                    try {
                        amount = Long.parseLong(args[2].trim());
                    } catch (NumberFormatException e) {
                        player.sendMessage("§c[Clan] Please enter a valid number of coins.");
                        return;
                    }
                    var body = new com.google.gson.JsonObject();
                    body.addProperty("action", isDeposit ? "deposit" : "withdraw");
                    body.addProperty("player_uuid", playerUuid.toString());
                    body.addProperty("player_username", playerName);
                    body.addProperty("amount", amount);

                    getServer().getScheduler().runTaskAsynchronously(this, () -> {
                        var resp = post(internalBase + "/clans/action", body.toString(), requestTimeout);
                        handleClanActionResponse(player, resp);
                        syncClans();
                    });
                    return;
                }
                ClanCacheEntry clan = clansById.get(clanId);
                if (clan != null) {
                    player.sendMessage(String.format(Locale.ROOT,
                        "§6[Clan Bank] §eClan §b[%s] §eTreasury: §6%s coins§e. Use §a/clan bank deposit <amt> §eor §a/clan bank withdraw <amt>§e.",
                        clan.tag, String.format(Locale.ROOT, "%,d", clan.coins)));
                } else {
                    player.sendMessage("§c[Clan] Clan information is refreshing, try again in a moment.");
                }
            }

            case "info" -> {
                UUID targetClanId = null;
                if (args.length >= 2) {
                    targetClanId = clanTagToId.get(args[1].toUpperCase(Locale.ROOT));
                } else {
                    targetClanId = playerToClanId.get(playerUuid);
                }
                if (targetClanId == null) {
                    player.sendMessage("§c[Clan] Clan not found.");
                    return;
                }
                ClanCacheEntry clan = clansById.get(targetClanId);
                if (clan == null) {
                    player.sendMessage("§c[Clan] Clan not found.");
                    return;
                }
                player.sendMessage(String.format(Locale.ROOT, "§6§l==== [Clan: [%s] %s] ====", clan.tag, clan.name));
                player.sendMessage(String.format(Locale.ROOT, "§7Members: §f%d §7| Treasury: §6%s coins", clan.members.size(), String.format(Locale.ROOT, "%,d", clan.coins)));
                player.sendMessage(String.format(Locale.ROOT, "§7Home: %s", clan.home != null ? "§aSet" : "§cNone"));
                if (!clan.allies.isEmpty()) player.sendMessage("§aAllies: §f" + String.join(", ", clan.allies));
                if (!clan.wars.isEmpty()) player.sendMessage("§cWars: §f" + String.join(", ", clan.wars));
                if (!clan.truces.isEmpty()) player.sendMessage("§bTruces: §f" + String.join(", ", clan.truces));
            }

            case "ally", "enemy", "war", "neutral", "truce" -> {
                if (args.length < 2) {
                    player.sendMessage("§c[Clan] Usage: /clan " + sub + " <TAG>");
                    return;
                }
                String relStatus = (sub.equals("enemy") || sub.equals("war")) ? "war" : sub;
                String targetTag = args[1].toUpperCase(Locale.ROOT);

                var body = new com.google.gson.JsonObject();
                body.addProperty("action", "relation");
                body.addProperty("player_uuid", playerUuid.toString());
                body.addProperty("player_username", playerName);
                body.addProperty("target_tag", targetTag);
                body.addProperty("status", relStatus);

                getServer().getScheduler().runTaskAsynchronously(this, () -> {
                    var resp = post(internalBase + "/clans/action", body.toString(), requestTimeout);
                    handleClanActionResponse(player, resp);
                    syncClans();
                });
            }

            case "disband" -> {
                var body = new com.google.gson.JsonObject();
                body.addProperty("action", "disband");
                body.addProperty("player_uuid", playerUuid.toString());
                body.addProperty("player_username", playerName);

                getServer().getScheduler().runTaskAsynchronously(this, () -> {
                    var resp = post(internalBase + "/clans/action", body.toString(), requestTimeout);
                    handleClanActionResponse(player, resp);
                    syncClans();
                });
            }

            default -> player.sendMessage("§c[Clan] Unknown subcommand. Type §e/clan help§c.");
        }
    }

    private void handleClanActionResponse(Player player, HttpResponse<String> resp) {
        if (resp != null && resp.statusCode() == 200) {
            try {
                var json = com.google.gson.JsonParser.parseString(resp.body()).getAsJsonObject();
                boolean success = json.has("success") && json.get("success").getAsBoolean();
                String msg = json.has("message") ? json.get("message").getAsString() : "";
                getServer().getScheduler().runTask(this, () -> {
                    if (!player.isOnline()) return;
                    player.sendMessage((success ? "§a" : "§c") + msg);
                    if (success) player.playSound(player.getLocation(), Sound.ENTITY_EXPERIENCE_ORB_PICKUP, 1.0f, 1.0f);
                });
            } catch (Exception e) {
                getServer().getScheduler().runTask(this, () -> {
                    if (player.isOnline()) player.sendMessage("§c[Clan] Error parsing server response.");
                });
            }
        } else {
            getServer().getScheduler().runTask(this, () -> {
                if (player.isOnline()) player.sendMessage("§c[Clan] Failed to communicate with server.");
            });
        }
    }

    // --- Offline Mail & Delivery Parcels --------------------------------------

    private void checkPendingMail(Player player) {
        if (!isEnabled() || player == null || !player.isOnline()) return;
        String uuid = player.getUniqueId().toString();
        getServer().getScheduler().runTaskLaterAsynchronously(this, () -> {
            if (!player.isOnline() || !isAuthenticated(player)) return;
            try {
                var body = new com.google.gson.JsonObject();
                body.addProperty("uuid", uuid);
                var resp = post(internalBase + "/mail/pending", body.toString(), requestTimeout);
                if (resp != null && resp.statusCode() == 200) {
                    var json = com.google.gson.JsonParser.parseString(resp.body()).getAsJsonObject();
                    if (json.has("has_pending") && json.get("has_pending").getAsBoolean()) {
                        var senders = json.getAsJsonArray("senders");
                        String sender = senders.size() > 0 ? senders.get(0).getAsString() : "someone";
                        getServer().getScheduler().runTask(this, () -> {
                            if (!player.isOnline() || !isAuthenticated(player)) return;
                            player.sendMessage(String.format(Locale.ROOT,
                                "§6§l[Mail] §eYou received a delivery from §b%s§e! Type §a/mail claim§e.", sender));
                            player.playSound(player.getLocation(), Sound.ENTITY_EXPERIENCE_ORB_PICKUP, 1.0f, 1.0f);
                        });
                    }
                }
            } catch (Exception e) {
                getLogger().warning("Failed to check pending mail on login: " + e.getMessage());
            }
        }, 30L);
    }

    private void openMailboxGui(Player player) {
        UUID uuid = player.getUniqueId();
        String uuidStr = uuid.toString();
        player.sendMessage("§e[Mail] Opening your postal inbox...");
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            try {
                var body = new com.google.gson.JsonObject();
                body.addProperty("uuid", uuidStr);
                var resp = post(internalBase + "/mail/pending", body.toString(), requestTimeout);
                com.google.gson.JsonArray senders = new com.google.gson.JsonArray();
                int count = 0;
                if (resp != null && resp.statusCode() == 200) {
                    var json = com.google.gson.JsonParser.parseString(resp.body()).getAsJsonObject();
                    count = json.get("count").getAsInt();
                    if (json.has("senders") && json.get("senders").isJsonArray()) {
                        senders = json.getAsJsonArray("senders");
                    }
                }
                int finalCount = count;
                com.google.gson.JsonArray finalSenders = senders;

                getServer().getScheduler().runTask(this, () -> {
                    if (!player.isOnline()) return;

                    MailboxHolder holder = new MailboxHolder(finalSenders);
                    Inventory inv = org.bukkit.Bukkit.createInventory(holder, 27, Component.text("§8Postal Mailbox & Deliveries"));
                    holder.setInventory(inv);

                    ItemStack pane = new ItemStack(Material.GRAY_STAINED_GLASS_PANE);
                    ItemMeta pm = pane.getItemMeta();
                    if (pm != null) {
                        pm.displayName(Component.text(" "));
                        pane.setItemMeta(pm);
                    }
                    for (int i = 0; i < 27; i++) {
                        inv.setItem(i, pane.clone());
                    }

                    // Slot 4: Mail status overview
                    ItemStack letter = new ItemStack(finalCount > 0 ? Material.WRITTEN_BOOK : Material.BOOK);
                    ItemMeta lm = letter.getItemMeta();
                    if (lm != null) {
                        lm.displayName(Component.text(finalCount > 0 ? "§6§l📬 Incoming Deliveries (" + finalCount + ")" : "§7📭 Mailbox is Empty"));
                        List<Component> lore = new ArrayList<>();
                        lore.add(Component.text("§7Player: §f" + player.getName()));
                        lore.add(Component.text("§7Pending deliveries: §e" + finalCount));
                        if (finalCount > 0 && finalSenders.size() > 0) {
                            lore.add(Component.text("§7From:"));
                            for (int s = 0; s < Math.min(finalSenders.size(), 3); s++) {
                                lore.add(Component.text("  §b• " + finalSenders.get(s).getAsString()));
                            }
                            if (finalSenders.size() > 3) {
                                lore.add(Component.text("  §7...and " + (finalSenders.size() - 3) + " more"));
                            }
                        } else {
                            lore.add(Component.text("§8No parcels waiting right now."));
                        }
                        lm.lore(lore);
                        letter.setItemMeta(lm);
                    }
                    inv.setItem(4, letter);

                    // Slot 13: Main action button (Claim All or Refresh)
                    if (finalCount > 0) {
                        ItemStack claimBox = new ItemStack(Material.CHEST);
                        ItemMeta cbm = claimBox.getItemMeta();
                        if (cbm != null) {
                            cbm.displayName(Component.text("§a§l▶ Claim All Deliveries (" + finalCount + ")"));
                            cbm.lore(List.of(
                                Component.text("§7Click to collect all pending parcels,"),
                                Component.text("§7items, and coins into your inventory."),
                                Component.text(""),
                                Component.text("§a§l[Click to Claim All]")
                            ));
                            claimBox.setItemMeta(cbm);
                        }
                        inv.setItem(13, claimBox);
                    } else {
                        ItemStack emptyBox = new ItemStack(Material.BARRIER);
                        ItemMeta ebm = emptyBox.getItemMeta();
                        if (ebm != null) {
                            ebm.displayName(Component.text("§cNo Deliveries to Claim"));
                            ebm.lore(List.of(
                                Component.text("§7You can receive parcels and gifts"),
                                Component.text("§7sent from the website or other players."),
                                Component.text(""),
                                Component.text("§e[Click to Refresh]")
                            ));
                            emptyBox.setItemMeta(ebm);
                        }
                        inv.setItem(13, emptyBox);
                    }

                    player.openInventory(inv);
                    player.playSound(player.getLocation(), Sound.ITEM_ARMOR_EQUIP_GENERIC, 0.8f, 1.2f);
                });
            } catch (Exception e) {
                getLogger().warning("[Mail] Failed to load mailbox GUI: " + e.getMessage());
            }
        });
    }

    private void handleMailboxClick(Player player, MailboxHolder holder, int slot) {
        if (slot == 13) {
            player.closeInventory();
            if (holder.getPendingList().size() > 0) {
                handleMailCommand(player, new String[]{"claim"});
            } else {
                openMailboxGui(player);
            }
        }
    }

    private void handleMailCommand(Player player, String[] args) {
        if (args.length == 0 || (args.length == 1 && (args[0].equalsIgnoreCase("gui") || args[0].equalsIgnoreCase("menu")))) {
            openMailboxGui(player);
            return;
        }
        boolean claim = (args.length == 1 && args[0].equalsIgnoreCase("claim"));
        boolean list = (args.length == 1 && args[0].equalsIgnoreCase("list"));

        if (!claim && !list) {
            player.sendMessage("§6§l[Mail] §eUsage: §a/mail (opens visual inbox), §a/mail claim§e, or §a/mail list");
            return;
        }

        UUID uuid = player.getUniqueId();
        String uuidStr = uuid.toString();

        if (list) {
            getServer().getScheduler().runTaskAsynchronously(this, () -> {
                try {
                    var body = new com.google.gson.JsonObject();
                    body.addProperty("uuid", uuidStr);
                    var resp = post(internalBase + "/mail/pending", body.toString(), requestTimeout);
                    if (resp != null && resp.statusCode() == 200) {
                        var json = com.google.gson.JsonParser.parseString(resp.body()).getAsJsonObject();
                        int count = json.get("count").getAsInt();
                        getServer().getScheduler().runTask(this, () -> {
                            if (!player.isOnline()) return;
                            if (count > 0) {
                                player.sendMessage(String.format(Locale.ROOT,
                                    "§6§l[Mail] §eYou have §b%d§e pending delivery(ies). Type §a/mail claim§e to collect them.", count));
                            } else {
                                player.sendMessage("§e[Mail] You have no pending deliveries.");
                            }
                        });
                    } else {
                        getServer().getScheduler().runTask(this, () -> {
                            if (player.isOnline()) player.sendMessage("§c[Mail] Could not check deliveries. Try again shortly.");
                        });
                    }
                } catch (Exception e) {
                    getLogger().warning("Mail check failed: " + e.getMessage());
                }
            });
            return;
        }

        player.sendMessage("§6§l[Mail] §eChecking for pending deliveries...");
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            try {
                var body = new com.google.gson.JsonObject();
                body.addProperty("uuid", uuidStr);
                var resp = post(internalBase + "/mail/claim", body.toString(), requestTimeout);
                if (resp != null && resp.statusCode() == 200) {
                    var arr = com.google.gson.JsonParser.parseString(resp.body()).getAsJsonArray();
                    getServer().getScheduler().runTask(this, () -> {
                        if (!player.isOnline()) return;
                        if (arr.isEmpty()) {
                            player.sendMessage("§c[Mail] You have no pending deliveries.");
                            return;
                        }

                        int claimedCount = 0;
                        for (var el : arr) {
                            var itemObj = el.getAsJsonObject();
                            String sender = itemObj.get("sender_username").getAsString();
                            long coins = itemObj.get("coins").getAsLong();
                            int qty = itemObj.get("quantity").getAsInt();
                            String msg = itemObj.has("message") ? itemObj.get("message").getAsString() : "";

                            if (coins > 0) {
                                player.sendMessage(String.format(Locale.ROOT,
                                    "§a§l[Mail] §eClaimed §6%d coins§e from §b%s§e!", coins, sender));
                            }

                            if (qty > 0) {
                                ItemStack stack = null;
                                if (itemObj.has("item_bytes") && !itemObj.get("item_bytes").isJsonNull()) {
                                    String b64 = itemObj.get("item_bytes").getAsString();
                                    if (b64 != null && !b64.isEmpty()) {
                                        try {
                                            byte[] raw = java.util.Base64.getDecoder().decode(b64);
                                            stack = ItemStack.deserializeBytes(raw);
                                            stack.setAmount(qty);
                                        } catch (Exception ignored) {}
                                    }
                                }
                                if (stack == null && itemObj.has("item") && !itemObj.get("item").isJsonNull()) {
                                    var it = itemObj.getAsJsonObject("item");
                                    String key = it.has("key") ? it.get("key").getAsString() : "minecraft:chest";
                                    Material mat = Material.matchMaterial(key);
                                    if (mat == null) mat = Material.CHEST;
                                    stack = new ItemStack(mat, qty);
                                    if (it.has("display_name") && !it.get("display_name").isJsonNull()) {
                                        var meta = stack.getItemMeta();
                                        if (meta != null) {
                                            meta.displayName(Component.text(it.get("display_name").getAsString()));
                                            stack.setItemMeta(meta);
                                        }
                                    }
                                }

                                if (stack != null && !stack.getType().isAir()) {
                                    String itemName = stack.getItemMeta() != null && stack.getItemMeta().hasDisplayName()
                                        ? net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer.plainText().serialize(stack.getItemMeta().displayName())
                                        : stack.getType().name().replace('_', ' ').toLowerCase(Locale.ROOT);

                                    var leftovers = player.getInventory().addItem(stack);
                                    if (!leftovers.isEmpty()) {
                                        for (ItemStack drop : leftovers.values()) {
                                            player.getWorld().dropItemNaturally(player.getLocation(), drop);
                                        }
                                        player.sendMessage("§e[Mail] Inventory full! Leftover items dropped safely at your feet.");
                                    }
                                    player.sendMessage(String.format(Locale.ROOT,
                                        "§a§l[Mail] §eClaimed §b%dx %s§e from §b%s§e!", qty, itemName, sender));
                                }
                            }

                            if (msg != null && !msg.isBlank()) {
                                player.sendMessage("§7\"" + msg + "\"");
                            }
                            claimedCount++;
                        }

                        player.playSound(player.getLocation(), Sound.UI_TOAST_CHALLENGE_COMPLETE, 1.0f, 1.0f);
                        player.sendMessage(String.format(Locale.ROOT,
                            "§a§l[Mail] §fSuccessfully collected %d delivery(ies)!", claimedCount));
                    });
                } else {
                    getServer().getScheduler().runTask(this, () -> {
                        if (player.isOnline()) player.sendMessage("§c[Mail] Failed to claim deliveries. Try again shortly.");
                    });
                }
            } catch (Exception e) {
                getLogger().warning("Mail claim failed: " + e.getMessage());
            }
        });
    }

    private void reportTerritoryAlertAsync(UUID uuid, String kind, String title, String message, int blockIndex, String world, int x, int y, int z) {
        if (internalBase == null || internalBase.isBlank() || serviceToken == null || serviceToken.isBlank()) return;
        var body = new com.google.gson.JsonObject();
        body.addProperty("uuid", uuid.toString());
        body.addProperty("kind", kind);
        body.addProperty("title", title);
        body.addProperty("message", message);
        body.addProperty("block_index", blockIndex);
        body.addProperty("world", world);
        body.addProperty("x", x);
        body.addProperty("y", y);
        body.addProperty("z", z);
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            try {
                post(internalBase + "/territory/alert", body.toString(), requestTimeout);
            } catch (Exception e) {
                getLogger().warning("Failed to report territory alert: " + e.getMessage());
            }
        });
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
