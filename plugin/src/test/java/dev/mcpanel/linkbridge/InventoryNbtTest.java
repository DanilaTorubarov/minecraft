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

        System.out.println("Inventory NBT regression checks passed");
    }
}
