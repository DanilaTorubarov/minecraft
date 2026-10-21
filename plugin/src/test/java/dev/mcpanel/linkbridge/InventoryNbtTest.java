package dev.mcpanel.linkbridge;

import dev.mcpanel.linkbridge.LinkBridgePlugin.InventoryNbt;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.GZIPOutputStream;

/** Runs without a Minecraft server; fixtures use the pinned server's save layout. */
public final class InventoryNbtTest {
    static void check(boolean value, String message) { if(!value) throw new AssertionError(message); }
    static void string(DataOutputStream out,String name,String value) throws IOException {
        out.writeByte(8); out.writeUTF(name); out.writeUTF(value);
    }
    static void item(DataOutputStream out, int slot, String name) throws IOException {
        if(slot >= 0) { out.writeByte(1); out.writeUTF("Slot"); out.writeByte(slot); }
        string(out,"id",name);
        out.writeByte(3); out.writeUTF("count"); out.writeInt(12);
        // Include a component invisible to the website's human-readable summary.
        out.writeByte(10); out.writeUTF("components");
        string(out,"minecraft:custom_data","keep me"); out.writeByte(0);
        out.writeByte(0);
    }
    static byte[] fixture() throws IOException {
        var buffer=new ByteArrayOutputStream();
        try(var out=new DataOutputStream(new GZIPOutputStream(buffer))) {
            out.writeByte(10); out.writeUTF("");
            out.writeByte(3); out.writeUTF("DataVersion"); out.writeInt(5000);
            out.writeByte(9); out.writeUTF("Inventory"); out.writeByte(10); out.writeInt(2);
            item(out,0,"minecraft:stone"); item(out,35,"minecraft:diamond");
            out.writeByte(10); out.writeUTF("equipment");
            for(String name:InventoryNbt.EQUIPMENT) { out.writeByte(10); out.writeUTF(name); item(out,-1,"minecraft:diamond"); }
            out.writeByte(0);
            out.writeByte(10); out.writeUTF("BukkitValues");
            string(out,"linkbridge:economy_task","{\"id\":\"paid-contract\",\"status\":\"done\"}");out.writeByte(0);
            string(out,"unrelated","preserve me");
            out.writeByte(7); out.writeUTF("bytes"); out.writeInt(3); out.write(new byte[]{0,1,-1});
            out.writeByte(11); out.writeUTF("ints"); out.writeInt(2); out.writeInt(42); out.writeInt(-42);
            out.writeByte(12); out.writeUTF("longs"); out.writeInt(1); out.writeLong(Long.MAX_VALUE);
            out.writeByte(0);
        }
        return buffer.toByteArray();
    }
    public static void main(String[] args) throws Exception {
        var original=fixture();
        var nbt=InventoryNbt.read(original);
        check(nbt.slots().keySet().equals(Set.of(0,35,36,37,38,39,40)),"Modern equipment mapping");
        var fingerprint=InventoryNbt.fingerprint(nbt.slots().get(0));
        check(fingerprint.equals(InventoryNbt.fingerprint(nbt.itemBytes(nbt.slots().get(0)))),"Online/offline fingerprint equivalence");
        check(!nbt.delete(0,"0".repeat(64),"stale"),"Stale snapshot must not delete");
        check(nbt.slots().containsKey(0),"Stale stack preserved");
        check(!nbt.delete(0,fingerprint,"stale"),"A retried conflict cannot delete a later matching item");
        check(nbt.delete(0,fingerprint,"request-one"),"Storage deletion");
        check(!nbt.slots().containsKey(0) && nbt.slots().containsKey(35),"Only selected stack removed");
        // A replacement after an acknowledgement is lost must survive replay.
        var replacement=InventoryNbt.read(original).inventory().values().getFirst();
        nbt.inventory().values().add(replacement);
        check(nbt.delete(0,fingerprint,"request-one"),"Replay acknowledged");
        check(nbt.slots().containsKey(0),"Replay preserves replacement");
        for(int slot=36;slot<=40;slot++) {
            check(nbt.delete(slot,InventoryNbt.fingerprint(nbt.slots().get(slot)),"equipment-"+slot),"Equipment deletion");
            check(!nbt.slots().containsKey(slot),"Equipment removed");
        }
        var dir=Files.createTempDirectory("linkbridge-nbt-test");
        var file=dir.resolve("player.dat"); Files.write(file,original);
        try {
            nbt.save(file);
            var saved=InventoryNbt.read(Files.readAllBytes(file));
            check(saved.receipt().equals("equipment-40:deleted"),"Receipt survives restart");
            check(saved.root.get("unrelated").value().equals("preserve me"),"Unrelated tags preserved");
            check(Arrays.equals((byte[])saved.root.get("bytes").value(),new byte[]{0,1,-1}),"Byte array preserved");
            check(((int[])saved.root.get("ints").value())[1] == -42,"Int array preserved");
            check(((long[])saved.root.get("longs").value())[0] == Long.MAX_VALUE,"Long array preserved");
            check(Arrays.equals(Files.readAllBytes(dir.resolve("player.dat.linkbridge-backup")),original),"Backup preserves exact original");
        } finally { try(var paths=Files.list(dir)) { for(var path:paths.toList()) Files.delete(path); } Files.delete(dir); }
        var partial=InventoryNbt.read(original);
        var originalItem=partial.slots().get(0);
        var smaller=new TreeMap<>(originalItem);
        smaller.put("count",new InventoryNbt.Tag(3,7));
        partial.replaceMarketItem(0,smaller);
        check(((Number)partial.slots().get(0).get("count").value()).intValue()==7,"Partial escrow preserves remaining amount");
        check(partial.slots().get(0).get("components").equals(originalItem.get("components")),"Partial escrow preserves components");
        partial.replaceMarketItem(0,null);
        check(!partial.slots().containsKey(0),"Full escrow removes only the selected slot");
        partial.replaceMarketItem(1,smaller);
        check(partial.slots().containsKey(1) && partial.slots().containsKey(35),"Delivery keeps unrelated storage");
        partial.replaceMarketItem(39,smaller);
        check(partial.slots().containsKey(39),"Equipment replacement keeps equipment layout");
        partial.replaceMarketItem(40,null);
        check(!partial.slots().containsKey(40),"Off-hand escrow removes equipment entry");
        partial.marketReceipt("{\"id\":\"durable\",\"status\":\"done\",\"item_bytes\":\"saved\"}");
        var persisted=InventoryNbt.read(partial.bytes());
        check(persisted.economyReceipt().equals(nbt.economyReceipt()) && persisted.economyReceipt().contains("paid-contract"),"Economy delivery receipt survives marketplace writes and restart independently");
        check(persisted.marketReceipt().contains("saved"),"Escrow bytes persist with the player receipt for replay");
        check(persisted.root.get("unrelated").value().equals("preserve me"),"Market mutation preserves player tags");
        boolean rejected=false;
        try { InventoryNbt.read(new byte[]{1,2,3}); } catch(IOException expected) { rejected=true; }
        check(rejected,"Malformed file rejected");
        var counters=new LinkBridgePlugin.EconomyCount();
        counters.fish=10001;counters.crops=3;counters.mined=10;counters.smelted=9;
        long[] accepted=counters.snapshot();counters.crops+=2;counters.smelted++;
        counters.subtract(accepted);
        check(Arrays.equals(counters.snapshot(),new long[]{0,0,1,2,0,1}),"Quest report acceptance preserves events arriving during the request and capped remainders");
        check(!counters.empty(),"Non-hunting progress must not be discarded as idle");
        counters.subtract(counters.snapshot());check(counters.empty(),"All objective counters drain after acceptance");
        check(LinkBridgePlugin.QuestRules.fish("COD")&&LinkBridgePlugin.QuestRules.fish("PUFFERFISH"),"Real fish qualify");
        check(!LinkBridgePlugin.QuestRules.fish("BOW")&&!LinkBridgePlugin.QuestRules.fish("LILY_PAD"),"Treasure and junk are not fish");
        check(LinkBridgePlugin.QuestRules.harvest("WHEAT",7,7)&&LinkBridgePlugin.QuestRules.harvest("BEETROOTS",3,3),"Mature supported crops qualify");
        check(!LinkBridgePlugin.QuestRules.harvest("WHEAT",6,7)&&!LinkBridgePlugin.QuestRules.harvest("WHEAT",0,7)&&!LinkBridgePlugin.QuestRules.harvest("COCOA",2,2),"Young replanted and unsupported crops cannot farm progress");

        // In-game /sell command price and lot calculations
        check(LinkBridgePlugin.SellRules.parseUnitPrice("10") == 10L, "Valid unit price parses");
        check(LinkBridgePlugin.SellRules.parseUnitPrice("1000000000") == 1000000000L, "Maximum 1B unit price parses");
        boolean unitZeroFailed = false;
        try { LinkBridgePlugin.SellRules.parseUnitPrice("0"); } catch (IllegalArgumentException e) { unitZeroFailed = true; }
        check(unitZeroFailed, "Unit price of 0 is rejected");
        boolean unitNegativeFailed = false;
        try { LinkBridgePlugin.SellRules.parseUnitPrice("-5"); } catch (IllegalArgumentException e) { unitNegativeFailed = true; }
        check(unitNegativeFailed, "Negative unit price is rejected");
        boolean unitOverflowFailed = false;
        try { LinkBridgePlugin.SellRules.parseUnitPrice("1000000001"); } catch (IllegalArgumentException e) { unitOverflowFailed = true; }
        check(unitOverflowFailed, "Unit price over 1B is rejected");

        // Lot price: default calculation (unit * quantity)
        check(LinkBridgePlugin.SellRules.parseLotPrice(null, 10L, 64) == 640L, "Default lot price computes unit * quantity");
        check(LinkBridgePlugin.SellRules.parseLotPrice(null, 500L, 1) == 500L, "Single-item default lot price equals unit price");
        // Lot price: explicit override
        check(LinkBridgePlugin.SellRules.parseLotPrice("500", 10L, 64) == 500L, "Explicit lot price override is preserved");
        boolean lotOverLimitFailed = false;
        try { LinkBridgePlugin.SellRules.parseLotPrice("1000000001", 10L, 64); } catch (IllegalArgumentException e) { lotOverLimitFailed = true; }
        check(lotOverLimitFailed, "Explicit lot price over 1B is rejected");
        boolean lotOverflowFailed = false;
        try { LinkBridgePlugin.SellRules.parseLotPrice(null, 50000000L, 30); } catch (ArithmeticException e) { lotOverflowFailed = true; }
        check(lotOverflowFailed, "Default lot price overflowing 1B is rejected");

        // Item display name formatting
        check(LinkBridgePlugin.SellRules.formatItemName("Custom Sword", "DIAMOND_SWORD").equals("Custom Sword"), "Custom display name preserved");
        check(LinkBridgePlugin.SellRules.formatItemName(null, "DIAMOND_SWORD").equals("Diamond Sword"), "Material name formatted cleanly");
        check(LinkBridgePlugin.SellRules.formatItemName(null, "OAK_PLANKS").equals("Oak Planks"), "Multi-word material name formatted cleanly");

        // In-game /market GUI and purchase rules
        check(LinkBridgePlugin.MarketRules.parsePage(null) == 1, "Null page defaults to 1");
        check(LinkBridgePlugin.MarketRules.parsePage("") == 1, "Blank page defaults to 1");
        check(LinkBridgePlugin.MarketRules.parsePage("0") == 1, "Page 0 clamped to 1");
        check(LinkBridgePlugin.MarketRules.parsePage("-5") == 1, "Negative page clamped to 1");
        check(LinkBridgePlugin.MarketRules.parsePage("abc") == 1, "Malformed page defaults to 1");
        check(LinkBridgePlugin.MarketRules.parsePage("4") == 4, "Valid page parses");

        // Purchase quantity computation
        check(LinkBridgePlugin.MarketRules.computePurchaseQuantity(false, 10L, 150L, 16) == 1, "Unit purchase buys 1");
        check(LinkBridgePlugin.MarketRules.computePurchaseQuantity(true, 10L, 150L, 16) == 16, "Lot purchase buys all remaining");
        check(LinkBridgePlugin.MarketRules.computePurchaseQuantity(false, null, 150L, 16) == 16, "Lot-only listing buys all remaining");

        // Purchase total computation
        check(LinkBridgePlugin.MarketRules.computePurchaseTotal(false, 10L, 150L, 2, 16) == 20L, "Unit total = unit_price * quantity");
        check(LinkBridgePlugin.MarketRules.computePurchaseTotal(true, 10L, 150L, 16, 16) == 150L, "Lot total = lot_price");

        // Title formatting
        check(LinkBridgePlugin.MarketRules.formatInventoryTitle(1, 3, "").equals("Marketplace (Page 1/3)"), "Default title formatted cleanly");
        check(LinkBridgePlugin.MarketRules.formatInventoryTitle(2, 5, "diamond").equals("Market (diamond) P.2/5"), "Filter title formatted cleanly");

        // Equipment repair rules and tier pricing
        // 1. Iron equipment (tools, weapons, armor)
        check(LinkBridgePlugin.RepairRules.isIronEquipment("IRON_SWORD"), "Iron sword qualifies");
        check(LinkBridgePlugin.RepairRules.isIronEquipment("IRON_PICKAXE"), "Iron pickaxe qualifies");
        check(LinkBridgePlugin.RepairRules.isIronEquipment("IRON_CHESTPLATE"), "Iron chestplate qualifies");
        check(LinkBridgePlugin.RepairRules.isRepairableMaterial("IRON_HELMET"), "Iron helmet is repairable");
        check(LinkBridgePlugin.RepairRules.unitPrice("IRON_SWORD") == 10L, "Iron repair price is 10 coins");

        // 2. Golden armor
        check(LinkBridgePlugin.RepairRules.isGoldenArmor("GOLDEN_HELMET"), "Golden helmet qualifies");
        check(LinkBridgePlugin.RepairRules.isGoldenArmor("GOLDEN_CHESTPLATE"), "Golden chestplate qualifies");
        check(LinkBridgePlugin.RepairRules.isGoldenArmor("GOLDEN_LEGGINGS"), "Golden leggings qualifies");
        check(LinkBridgePlugin.RepairRules.isGoldenArmor("GOLDEN_BOOTS"), "Golden boots qualifies");
        check(!LinkBridgePlugin.RepairRules.isGoldenArmor("GOLDEN_SWORD"), "Golden sword is not armor");
        check(!LinkBridgePlugin.RepairRules.isGoldenArmor("GOLDEN_PICKAXE"), "Golden pickaxe is not armor");
        check(LinkBridgePlugin.RepairRules.isRepairableMaterial("GOLDEN_CHESTPLATE"), "Golden chestplate is repairable");
        check(!LinkBridgePlugin.RepairRules.isRepairableMaterial("GOLDEN_AXE"), "Golden axe is not repairable");
        check(LinkBridgePlugin.RepairRules.unitPrice("GOLDEN_CHESTPLATE") == 15L, "Golden armor repair price is 15 coins");

        // 3. Diamond armor
        check(LinkBridgePlugin.RepairRules.isDiamondArmor("DIAMOND_HELMET"), "Diamond helmet qualifies");
        check(LinkBridgePlugin.RepairRules.isDiamondArmor("DIAMOND_CHESTPLATE"), "Diamond chestplate qualifies");
        check(LinkBridgePlugin.RepairRules.isDiamondArmor("DIAMOND_LEGGINGS"), "Diamond leggings qualifies");
        check(LinkBridgePlugin.RepairRules.isDiamondArmor("DIAMOND_BOOTS"), "Diamond boots qualifies");
        check(!LinkBridgePlugin.RepairRules.isDiamondArmor("DIAMOND_SWORD"), "Diamond sword is not armor");
        check(!LinkBridgePlugin.RepairRules.isDiamondArmor("DIAMOND_SHOVEL"), "Diamond shovel is not armor");
        check(LinkBridgePlugin.RepairRules.isRepairableMaterial("DIAMOND_BOOTS"), "Diamond boots is repairable");
        check(!LinkBridgePlugin.RepairRules.isRepairableMaterial("DIAMOND_HOE"), "Diamond hoe is not repairable");
        check(LinkBridgePlugin.RepairRules.unitPrice("DIAMOND_LEGGINGS") == 60L, "Diamond armor repair price is 60 coins");

        // 4. Netherite armor
        check(LinkBridgePlugin.RepairRules.isNetheriteArmor("NETHERITE_HELMET"), "Netherite helmet qualifies");
        check(LinkBridgePlugin.RepairRules.isNetheriteArmor("NETHERITE_CHESTPLATE"), "Netherite chestplate qualifies");
        check(LinkBridgePlugin.RepairRules.isNetheriteArmor("NETHERITE_LEGGINGS"), "Netherite leggings qualifies");
        check(LinkBridgePlugin.RepairRules.isNetheriteArmor("NETHERITE_BOOTS"), "Netherite boots qualifies");
        check(!LinkBridgePlugin.RepairRules.isNetheriteArmor("NETHERITE_SWORD"), "Netherite sword is not armor");
        check(!LinkBridgePlugin.RepairRules.isNetheriteArmor("NETHERITE_PICKAXE"), "Netherite pickaxe is not armor");
        check(LinkBridgePlugin.RepairRules.isRepairableMaterial("NETHERITE_HELMET"), "Netherite helmet is repairable");
        check(!LinkBridgePlugin.RepairRules.isRepairableMaterial("NETHERITE_SWORD"), "Netherite sword is not repairable");
        check(LinkBridgePlugin.RepairRules.unitPrice("NETHERITE_HELMET") == 175L, "Netherite armor repair price is 175 coins");

        // 5. Other unrepairable materials
        check(!LinkBridgePlugin.RepairRules.isRepairableMaterial("LEATHER_CHESTPLATE"), "Leather chestplate is not repairable");
        check(!LinkBridgePlugin.RepairRules.isRepairableMaterial("CHAINMAIL_HELMET"), "Chainmail is not repairable");
        check(!LinkBridgePlugin.RepairRules.isRepairableMaterial("BOW"), "Bow is not repairable");
        check(!LinkBridgePlugin.RepairRules.isRepairableMaterial("DIRT"), "Dirt is not repairable");
        check(LinkBridgePlugin.RepairRules.unitPrice("LEATHER_CHESTPLATE") == null, "Unrepairable item has null unit price");

        // Private block rules
        check(LinkBridgePlugin.PrivateRules.nextBlockPrice(0) == 500L, "1st private block price is 500");
        check(LinkBridgePlugin.PrivateRules.nextBlockPrice(1) == 20000L, "2nd private block price is 20000");
        check(LinkBridgePlugin.PrivateRules.nextBlockPrice(2) == 50000L, "3rd private block price is 50000");
        check(LinkBridgePlugin.PrivateRules.nextBlockPrice(3) == -1L, "4th private block is rejected");
        check(LinkBridgePlugin.PrivateRules.radiusToSize(1) == 3, "Radius 1 is size 3x3");
        check(LinkBridgePlugin.PrivateRules.radiusToSize(3) == 7, "Radius 3 is size 7x7");
        check(LinkBridgePlugin.PrivateRules.radiusToSize(5) == 11, "Radius 5 is size 11x11");
        check(LinkBridgePlugin.PrivateRules.radiusToSize(7) == 15, "Radius 7 is size 15x15");
        check(LinkBridgePlugin.PrivateRules.sizeToRadius(15) == 7, "Size 15 has radius 7");
        check(LinkBridgePlugin.PrivateRules.isInside(107, 207, 100, 200, 7), "Coordinate inside 15x15 boundary");
        check(!LinkBridgePlugin.PrivateRules.isInside(108, 200, 100, 200, 7), "Coordinate outside 15x15 boundary");
        var owner = UUID.randomUUID();
        var member = UUID.randomUUID();
        var stranger = UUID.randomUUID();
        check(LinkBridgePlugin.PrivateRules.canAccess(owner, owner, List.of(member)), "Owner can access");
        check(LinkBridgePlugin.PrivateRules.canAccess(member, owner, List.of(member)), "Member can access");
        check(!LinkBridgePlugin.PrivateRules.canAccess(stranger, owner, List.of(member)), "Stranger cannot access");

        // Fuel rules
        check(LinkBridgePlugin.FuelRules.fuelDuration(1) == 7200L, "Tier 1 fuel gives 2 hours");
        check(LinkBridgePlugin.FuelRules.fuelDuration(4) == 21600L, "Tier 4 fuel gives 6 hours");
        check(LinkBridgePlugin.FuelRules.fuelRadius(1) == 1, "Tier 1 fuel gives radius 1 (3x3)");
        check(LinkBridgePlugin.FuelRules.fuelRadius(4) == 7, "Tier 4 fuel gives radius 7 (15x15)");
        check(LinkBridgePlugin.FuelRules.calculateNewTier(1, 4) == 4, "Higher crystal tier upgrades zone tier");
        check(LinkBridgePlugin.FuelRules.calculateNewTier(4, 2) == 4, "Lower crystal tier retains existing higher tier");
        check(LinkBridgePlugin.FuelRules.calculateNewFuel(1000L, 1) == 8200L, "Fuel addition accumulates duration");
        check(LinkBridgePlugin.FuelRules.calculateNewFuel(LinkBridgePlugin.FuelRules.MAX_STORED_FUEL - 100L, 4) == LinkBridgePlugin.FuelRules.MAX_STORED_FUEL, "Fuel accumulation caps at 72 hours");
        check(LinkBridgePlugin.FuelRules.oreTier("COPPER_ORE") == 1, "Copper is Tier 1");
        check(LinkBridgePlugin.FuelRules.oreTier("DEEPSLATE_LAPIS_ORE") == 2, "Lapis is Tier 2");
        check(LinkBridgePlugin.FuelRules.oreTier("REDSTONE_ORE") == 3, "Redstone is Tier 3");
        check(LinkBridgePlugin.FuelRules.oreTier("DEEPSLATE_EMERALD_ORE") == 4, "Emerald is Tier 4");
        check(LinkBridgePlugin.FuelRules.oreTier("STONE") == 0, "Stone is Tier 0");
        check(LinkBridgePlugin.FuelRules.isNonFuelOre("COAL_ORE"), "Coal ore is non-fuel");
        check(LinkBridgePlugin.FuelRules.isNonFuelOre("DEEPSLATE_IRON_ORE"), "Deepslate iron ore is non-fuel");
        check(LinkBridgePlugin.FuelRules.isNonFuelOre("GOLD_ORE"), "Gold ore is non-fuel");
        check(LinkBridgePlugin.FuelRules.isNonFuelOre("DIAMOND_ORE"), "Diamond ore is non-fuel");
        check(!LinkBridgePlugin.FuelRules.isNonFuelOre("COPPER_ORE"), "Copper ore is fuel");
        check(!LinkBridgePlugin.FuelRules.isNonFuelOre("LAPIS_ORE"), "Lapis ore is fuel");
        check(!LinkBridgePlugin.FuelRules.isNonFuelOre("REDSTONE_ORE"), "Redstone ore is fuel");
        check(!LinkBridgePlugin.FuelRules.isNonFuelOre("EMERALD_ORE"), "Emerald ore is fuel");
        check(!LinkBridgePlugin.FuelRules.isNonFuelOre("STONE"), "Stone is not an ore");

        // Prospector pickaxe rules
        check(LinkBridgePlugin.PickaxeRules.pickaxePrice(1) == 150L, "Tier 1 pickaxe price is 150");
        check(LinkBridgePlugin.PickaxeRules.pickaxePrice(2) == 1000L, "Tier 2 pickaxe price is 1000");
        check(LinkBridgePlugin.PickaxeRules.pickaxePrice(3) == 5000L, "Tier 3 pickaxe price is 5000");
        check(LinkBridgePlugin.PickaxeRules.pickaxePrice(4) == 20000L, "Tier 4 pickaxe price is 20000");
        check(LinkBridgePlugin.PickaxeRules.canMineTier(1, 1), "Tier 1 pickaxe can mine Tier 1 ore");
        check(!LinkBridgePlugin.PickaxeRules.canMineTier(1, 2), "Tier 1 pickaxe cannot mine Tier 2 ore");
        check(LinkBridgePlugin.PickaxeRules.canMineTier(3, 2), "Tier 3 pickaxe can mine Tier 2 ore");
        check(LinkBridgePlugin.PickaxeRules.canMineTier(4, 4), "Tier 4 pickaxe can mine Tier 4 ore");

        // Expedition rules
        long now = 1000000L;
        check(LinkBridgePlugin.ExpeditionRules.canEnter(0L, now), "First entry is allowed");
        check(LinkBridgePlugin.ExpeditionRules.canEnter(now - 14400L, now), "Entry allowed after 4 hours");
        check(!LinkBridgePlugin.ExpeditionRules.canEnter(now - 3600L, now), "Entry rejected during 4-hour cooldown");
        check(LinkBridgePlugin.ExpeditionRules.remainingCooldown(now - 3600L, now) == 10800L, "Remaining cooldown computes correctly");
        check(LinkBridgePlugin.ExpeditionRules.formatDuration(300L).equals("05:00"), "5 minutes formats as 05:00");
        check(LinkBridgePlugin.ExpeditionRules.formatDuration(45L).equals("00:45"), "45 seconds formats as 00:45");

        // Raid rules
        check(LinkBridgePlugin.RaidRules.BREACH_DURATION_SECONDS == 300L, "Breach lasts 5 minutes");
        check(LinkBridgePlugin.RaidRules.BREACH_RADIUS == 3, "Breach radius is 3 blocks");
        check(LinkBridgePlugin.RaidRules.FUSE_SECONDS == 10, "Fuse is 10 seconds");
        check(LinkBridgePlugin.RaidRules.CHARGE_PRICE == 2500L, "Breach charge costs 2500 coins");

        // Private zone creeper and explosion defense rules
        var ownerUuid = UUID.randomUUID();
        var memberUuid = UUID.randomUUID();
        var strangerUuid = UUID.randomUUID();
        var zoneMembers = List.of(memberUuid);

        check(LinkBridgePlugin.PrivateRules.canExplosionDamageZone(ownerUuid, ownerUuid, zoneMembers),
            "Owner triggering creeper in own base allows damage (vanilla consequences)");
        check(LinkBridgePlugin.PrivateRules.canExplosionDamageZone(memberUuid, ownerUuid, zoneMembers),
            "Member triggering creeper in base allows damage");
        check(!LinkBridgePlugin.PrivateRules.canExplosionDamageZone(strangerUuid, ownerUuid, zoneMembers),
            "Stranger triggering creeper must NOT damage private zone blocks");
        check(!LinkBridgePlugin.PrivateRules.canExplosionDamageZone(null, ownerUuid, zoneMembers),
            "Unidentified / untargeted creeper explosion must NOT damage private zone blocks");

        System.out.println("Inventory NBT regression checks passed");
    }
}
