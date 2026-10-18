# Inventory texture sources

The item and block textures are original Minecraft assets by Mojang/Microsoft, obtained from the official Minecraft Java Edition 26.3 client. No item artwork is generated or redrawn.

`prepareItemTextures` in `build.gradle` resolves the client through Mojang's [version manifest](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json), verifies the metadata against its manifest SHA-1 and verifies the client jar against the metadata SHA-1, then packages `assets/minecraft/textures/item/**/*.png` and `assets/minecraft/textures/block/**/*.png` as plugin resources. The original client jar and metadata stay in the ignored `.plugin-build/client-textures/` cache. The installed plugin contains only the selected original PNGs, not the client program.

Dedicated-server jars do not contain this artwork. JavaPlugin.getResource reads the plugin jar, so the images must be explicitly packaged there. Items without a corresponding PNG retain the sourced Performance Center fallback and an accessible name; model rendering and resource-pack overrides are not implemented.

Minecraft assets remain owned by Mojang/Microsoft; this project does not claim ownership or grant a new license. See the [Minecraft usage guidelines](https://www.minecraft.net/en-us/usage-guidelines).
