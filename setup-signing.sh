#!/usr/bin/env bash
set -e

ANDROID_DIR="src-tauri/gen/android"
KEYSTORE_PATH="$ANDROID_DIR/dexdroid.keystore"
PROPS_PATH="$ANDROID_DIR/keystore.properties"
GRADLE_PATH="$ANDROID_DIR/app/build.gradle.kts"

if [ ! -d "$ANDROID_DIR" ]; then
  echo "❌ Run 'pnpm tauri android init' first"
  exit 1
fi

read -s -p "🔑 Set a keystore password (remember this!): " PASSWORD
echo ""

# 1. Generate keystore (skip if exists)
if [ -f "$KEYSTORE_PATH" ]; then
  echo "⏭️  Keystore already exists, skipping generation"
else
  echo "🔨 Generating keystore..."
  keytool -genkey -v \
    -keystore "$KEYSTORE_PATH" \
    -alias dexdroid \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$PASSWORD" -keypass "$PASSWORD" \
    -dname "CN=dexdroid, OU=Dev, O=Binatec, L=Lagos, ST=Lagos, C=NG"
fi

# 2. Write keystore.properties
echo "📝 Writing keystore.properties..."
cat > "$PROPS_PATH" << PROPS
password=$PASSWORD
keyAlias=dexdroid
storeFile=dexdroid.keystore
PROPS

# 3. Patch build.gradle.kts (skip if already patched)
if grep -q "signingConfigs" "$GRADLE_PATH"; then
  echo "⏭️  Gradle already configured for signing"
else
  echo "🔧 Patching build.gradle.kts..."
  # Add imports at top
  sed -i '1i import java.io.FileInputStream\nimport java.util.Properties\n\nval keystorePropertiesFile = rootProject.file("keystore.properties")\nval keystoreProperties = Properties()\nif (keystorePropertiesFile.exists()) {\n    keystoreProperties.load(FileInputStream(keystorePropertiesFile))\n}\n' "$GRADLE_PATH"

  # Insert signingConfigs + update release buildType inside android {}
  python3 << PYEOF
import re
path = "$GRADLE_PATH"
with open(path) as f:
    content = f.read()

signing_block = '''
    signingConfigs {
        create("release") {
            keyAlias = keystoreProperties["keyAlias"] as String
            keyPassword = keystoreProperties["password"] as String
            storeFile = file(keystoreProperties["storeFile"] as String)
            storePassword = keystoreProperties["password"] as String
        }
    }

    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = false
        }
    }
'''

# Insert just before the closing brace of android { }
content = re.sub(r'(android\s*\{)', r'\1' + signing_block, content, count=1)

with open(path, 'w') as f:
    f.write(content)
PYEOF
fi

# 4. Gitignore secrets
GITIGNORE="$ANDROID_DIR/.gitignore"
touch "$GITIGNORE"
for entry in "keystore.properties" "*.keystore" "*.jks"; do
  grep -qxF "$entry" "$GITIGNORE" || echo "$entry" >> "$GITIGNORE"
done

echo ""
echo "✅ Signing setup complete"
echo ""
echo "⚠️  BACK UP $KEYSTORE_PATH NOW"
echo "    Download it from VS Code file explorer to your laptop."
echo "    If you lose it, you can never update this app on Play Store."
echo ""
echo "Next: ./build-apk.sh"
