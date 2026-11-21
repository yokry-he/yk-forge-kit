# Build from repository root. Supply verified SHA256s; no mutable "latest" SDK selection.
FROM eclipse-temurin:17.0.17_10-jdk-jammy AS toolchain
ARG CMDLINE_SHA256
ARG GRADLE_SHA256
ARG DCLOUD_SHA256
ENV ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip python3 ca-certificates && rm -rf /var/lib/apt/lists/*
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN test "${#CMDLINE_SHA256}" = 64 && test "${#GRADLE_SHA256}" = 64 \
 && curl --fail --location --retry 3 https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip -o /tmp/tools.zip \
 && echo "$CMDLINE_SHA256  /tmp/tools.zip" | sha256sum -c - \
 && mkdir -p /opt/android-sdk/cmdline-tools && unzip -q /tmp/tools.zip -d /opt/android-sdk/cmdline-tools \
 && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/19.0 \
 && printf 'y\n%.0s' {1..100} | /opt/android-sdk/cmdline-tools/19.0/bin/sdkmanager --licenses >/dev/null \
 && /opt/android-sdk/cmdline-tools/19.0/bin/sdkmanager 'platforms;android-36' 'build-tools;36.0.0' \
 && curl --fail --location --retry 3 https://services.gradle.org/distributions/gradle-8.14.3-bin.zip -o /tmp/gradle.zip \
 && echo "$GRADLE_SHA256  /tmp/gradle.zip" | sha256sum -c - \
 && unzip -q /tmp/gradle.zip -d /opt && mv /opt/gradle-8.14.3 /opt/gradle && rm /tmp/*.zip
# Private, normalized SDK archive, prepared from the licensed matching 5.34 offline distribution.
# Required top-level paths: libs/, assets/data/, res/, VERSION (literal 5.34).
COPY infra/android/vendor/dcloud-5.34.tar /tmp/dcloud.tar
RUN test "${#DCLOUD_SHA256}" = 64 && echo "$DCLOUD_SHA256  /tmp/dcloud.tar" | sha256sum -c - \
 && mkdir /opt/dcloud && tar -xf /tmp/dcloud.tar -C /opt/dcloud && rm /tmp/dcloud.tar \
 && test "$(cat /opt/dcloud/VERSION)" = '5.34' \
 && test -f /opt/dcloud/libs/uniapp-v8-release.aar \
 && test -f /opt/dcloud/libs/lib.5plus.base-release.aar \
 && test -f /opt/dcloud/assets/data/dcloud_control.xml
COPY infra/android/project /opt/android/project
COPY infra/android/package.py /opt/android/package.py
RUN cp -a /opt/dcloud/libs /opt/android/project/app/libs \
 && cp -a /opt/dcloud/assets /opt/android/project/app/src/main/assets \
 && cp -a /opt/dcloud/res /opt/android/project/app/src/main/res \
 && rm -rf /opt/dcloud \
 && printf '%s' '{"settings":{"packageName":"io.forgekit.smoke","appKey":"image-warmup","versionCode":1,"versionName":"1.0.0"},"input":{"buildType":"release","kind":"apk"}}' > /opt/android/project/job.json \
 && cd /opt/android/project && /opt/gradle/bin/gradle --no-daemon --console=plain -g /opt/android/cache :app:assembleRelease :app:bundleRelease \
 && rm -rf .gradle app/build job.json \
 && chmod -R a+rX /opt/android /opt/android-sdk /opt/gradle
# Gate image acceptance with the same offline tasks, not merely a cached dependency resolution.
RUN cd /opt/android/project \
 && printf '%s' '{"settings":{"packageName":"io.forgekit.smoke","appKey":"image-warmup","versionCode":1,"versionName":"1.0.0"},"input":{"buildType":"debug","kind":"aab"}}' > job.json \
 && /opt/gradle/bin/gradle --offline --no-daemon --console=plain -g /opt/android/cache :app:assembleRelease :app:bundleRelease \
 && rm -rf .gradle app/build job.json
# A stable development certificate for this image, never used for release signing.
RUN keytool -genkeypair -keystore /opt/android/debug.keystore -alias androiddebugkey -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 3650 -dname 'CN=Android Debug,O=Android,C=US' -storetype JKS \
 && keytool -list -v -keystore /opt/android/debug.keystore -storepass android > /opt/android/debug-certificate.txt \
 && chmod 444 /opt/android/debug.keystore /opt/android/debug-certificate.txt
USER 10001:10001
WORKDIR /tmp
