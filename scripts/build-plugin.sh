#!/usr/bin/env sh
#
# Builds the LinkBridge plugin and installs the jar into the backend's plugins
# directory.
#
#   ./scripts/build-plugin.sh
#
# Everything happens inside throwaway containers, so nothing needs to be
# installed on the host: Gradle (which resolves the Paper API and its transitive
# dependencies from Maven) and the AuthMe API jar, cached in .plugin-build/
# (gitignored). The finished jar lands in mc/purpur/plugins/ so it travels with
# the server data — the machine you move the stack to never needs a JDK.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
resources="$root/plugin/src/main/resources"
lib="$root/.plugin-build/lib"

# Must match PLUGINS in compose.yaml, and the JDK must match the backend's Java
# (itzg/minecraft-server runs Java 25, and paper-api 26.3 is built for it).
AUTHME="6.0.1"
GRADLE_IMAGE="gradle:jdk25"
SKINSRESTORER="15.12.6"

version="$(sed -n "s/^version:[[:space:]]*'\{0,1\}\([^']*\)'\{0,1\}[[:space:]]*$/\1/p" \
  "$resources/plugin.yml" | head -n1)"
if [ -z "$version" ]; then
  echo "build-plugin: could not read 'version' from plugin.yml" >&2
  exit 1
fi

mkdir -p "$lib"
authme_jar="$lib/AuthMe-$AUTHME-Paper.jar"
if [ ! -s "$authme_jar" ]; then
  echo "build-plugin: downloading AuthMe-$AUTHME-Paper.jar"
  curl -fsSL --retry 3 -o "$authme_jar.part" \
    "https://github.com/AuthMe/AuthMeReloaded/releases/download/$AUTHME/AuthMe-$AUTHME-Paper.jar"
  mv "$authme_jar.part" "$authme_jar"
fi

skin_jar="$lib/SkinsRestorer-$SKINSRESTORER.jar"
if [ ! -s "$skin_jar" ]; then
  curl -fsSL --retry 3 -o "$skin_jar.part" \
    "https://github.com/SkinsRestorer/SkinsRestorer/releases/download/$SKINSRESTORER/SkinsRestorer.jar"
  mv "$skin_jar.part" "$skin_jar"
fi
skin_hash="$(shasum -a 256 "$skin_jar" | cut -d ' ' -f 1)"
if [ "$skin_hash" != "a85b4a370f988741c9a38f4d0498262edacbf3220314790ac1c127461996359c" ]; then
  echo "build-plugin: SkinsRestorer checksum mismatch" >&2
  exit 1
fi

echo "build-plugin: building LinkBridge $version"
docker run --rm \
  -v "$root:/w" -w /w/plugin \
  -e GRADLE_USER_HOME=/w/.plugin-build/gradle-home \
  "$GRADLE_IMAGE" \
  gradle --no-daemon --console=plain -PpluginVersion="$version" jar

built="$root/plugin/build/libs/LinkBridge-$version.jar"
if [ ! -s "$built" ]; then
  echo "build-plugin: Gradle did not produce $built" >&2
  exit 1
fi

dest="$root/mc/purpur/plugins/LinkBridge-$version.jar"
mkdir -p "$(dirname "$dest")"
for previous in "$root"/mc/purpur/plugins/LinkBridge-*.jar; do
  [ -f "$previous" ] || continue
  [ "$previous" = "$dest" ] || mv "$previous" "$previous.disabled"
done
cp "$built" "$dest"
echo "build-plugin: installed $dest"
