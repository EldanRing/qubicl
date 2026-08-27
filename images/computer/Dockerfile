FROM node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c AS filesystem-base

ARG QUBICL_VERSION=development
ARG QUBICL_REVISION=unknown
ARG QUBICL_CREATED=unknown
ARG QUBICL_SOURCE=https://github.com/EldanRing/qubicl

LABEL org.opencontainers.image.title="Qubicl computer" \
      org.opencontainers.image.description="Private Docker computer for compatible AI agents" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="$QUBICL_SOURCE" \
      org.opencontainers.image.url="$QUBICL_SOURCE" \
      org.opencontainers.image.version="$QUBICL_VERSION" \
      org.opencontainers.image.revision="$QUBICL_REVISION" \
      org.opencontainers.image.created="$QUBICL_CREATED"

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      fd-find \
      file \
      gh \
      git \
      jq \
      procps \
      python3 \
      python3-venv \
      ripgrep \
      sudo \
      tini \
      tree \
      unzip \
      wget \
      zip \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

ARG NPM_VERSION=12.0.2
RUN npm install --global "npm@$NPM_VERSION" \
 && npm install --prefix /tmp/npm-security-patches \
      --ignore-scripts --no-audit --no-fund --package-lock=false \
      brace-expansion@5.0.9 ip-address@10.3.1 tar@7.5.21 \
 && rm -rf \
      /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
      /usr/local/lib/node_modules/npm/node_modules/ip-address \
      /usr/local/lib/node_modules/npm/node_modules/tar \
 && cp -a /tmp/npm-security-patches/node_modules/brace-expansion \
      /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
 && cp -a /tmp/npm-security-patches/node_modules/ip-address \
      /usr/local/lib/node_modules/npm/node_modules/ip-address \
 && cp -a /tmp/npm-security-patches/node_modules/tar \
      /usr/local/lib/node_modules/npm/node_modules/tar \
 && rm -rf /tmp/npm-security-patches \
 && npm cache clean --force

RUN groupmod --new-name qubicl node \
 && usermod --login qubicl --home /home/qubicl --move-home --shell /bin/bash node \
 && rm -f /etc/sudoers.d/qubicl \
 && install -d -o qubicl -g qubicl /opt/qubicl

COPY --chown=qubicl:qubicl control.mjs /opt/qubicl/control.mjs
COPY --chown=qubicl:qubicl web-provider.py /opt/qubicl/web-provider.py
COPY web-requirements.txt /opt/qubicl/web-requirements.txt
COPY --chown=qubicl:qubicl skills /opt/qubicl/skills
COPY LICENSE THIRD_PARTY_NOTICES.txt WEB_THIRD_PARTY_NOTICES.txt /usr/share/doc/qubicl/
COPY entrypoint.sh /usr/local/bin/qubicl-entrypoint
RUN python3 -m venv /opt/qubicl/web-venv \
 && /opt/qubicl/web-venv/bin/pip install --no-cache-dir --requirement /opt/qubicl/web-requirements.txt \
 && install -d /usr/share/doc/qubicl/web-python-licenses \
 && find /opt/qubicl/web-venv/lib -type f \( -iname 'LICENSE*' -o -iname 'COPYING*' \) \
      -exec cp --parents '{}' /usr/share/doc/qubicl/web-python-licenses/ \; \
 && find /opt/qubicl/web-venv -type d -name __pycache__ -prune -exec rm -rf '{}' + \
 && chmod 0755 /usr/local/bin/qubicl-entrypoint /opt/qubicl/web-provider.py \
 && chown -R qubicl:qubicl /opt/qubicl/web-venv

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/qubicl-entrypoint"]

FROM filesystem-base AS display-browser-base

COPY --chown=qubicl:qubicl node_modules/playwright-core /opt/qubicl/node_modules/playwright-core
COPY PLAYWRIGHT_THIRD_PARTY_NOTICES.txt /usr/share/doc/qubicl/
COPY chromium-wrapper.sh /usr/local/bin/qubicl-chromium
COPY --chown=root:root qubicl_viewer_auth.py /usr/lib/python3/dist-packages/qubicl_viewer_auth.py
COPY x11vnc-relay.sh /usr/local/bin/qubicl-x11vnc-relay

# noVNC is static browser content at runtime. Extract Debian's signed package
# without installing its unnecessary dependency on Debian's second Node stack.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      dbus-x11 \
      fonts-dejavu-core \
      scrot \
      socat \
      websockify \
      x11-utils \
      x11-xserver-utils \
      x11vnc \
      xclip \
      xdotool \
      xdg-utils \
      xserver-xorg-core \
      xvfb \
 && install -d -m 0755 -o _apt -g root /tmp/qubicl-novnc-package \
 && cd /tmp/qubicl-novnc-package \
 && apt-get download novnc \
 && dpkg-deb --extract ./novnc_*.deb / \
 && cd / \
 && test -s /usr/share/novnc/vnc.html \
 && test -s /usr/share/doc/novnc/copyright \
 && rm -rf /tmp/qubicl-novnc-package /var/lib/apt/lists/* \
 && rm -f /etc/chromium.d/dev-shm \
 && groupadd --system qubicl-viewer \
 && useradd --system --gid qubicl-viewer --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin qubicl-viewer \
 && chmod 0444 /usr/lib/python3/dist-packages/qubicl_viewer_auth.py \
 && chmod 0755 /usr/local/bin/qubicl-chromium /usr/local/bin/qubicl-x11vnc-relay \
 && ln -s qubicl-x11vnc-relay /usr/local/bin/qubicl-x11vnc-view \
 && ln -s qubicl-x11vnc-relay /usr/local/bin/qubicl-x11vnc-control \
 && python3 -I -c 'import qubicl_viewer_auth; assert qubicl_viewer_auth.__file__ == "/usr/lib/python3/dist-packages/qubicl_viewer_auth.py"' \
 && runuser -u qubicl -- test ! -w /usr/lib/python3/dist-packages/qubicl_viewer_auth.py \
 && printf 'CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-first-run --no-default-browser-check"\n' >/etc/chromium.d/qubicl-container

FROM display-browser-base AS document-inspection-base
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      poppler-utils \
      tesseract-ocr \
      tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*

FROM document-inspection-base AS browser-runtime
COPY browser-skills-requirements.txt /opt/qubicl/browser-skills-requirements.txt
COPY BROWSER_SKILLS_THIRD_PARTY_NOTICES.txt /usr/share/doc/qubicl/
RUN apt-get update \
 && apt-get install -y --no-install-recommends openbox \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/qubicl/skills-venv \
 && /opt/qubicl/skills-venv/bin/pip install --no-cache-dir --requirement /opt/qubicl/browser-skills-requirements.txt \
 && install -d /usr/share/doc/qubicl/skills-python-licenses \
 && find /opt/qubicl/skills-venv/lib -type f \( -iname 'LICENSE*' -o -iname 'COPYING*' \) \
      -exec cp --parents '{}' /usr/share/doc/qubicl/skills-python-licenses/ \; \
 && find /opt/qubicl/skills-venv -type d -name __pycache__ -prune -exec rm -rf '{}' + \
 && chown -R qubicl:qubicl /opt/qubicl/skills-venv

FROM document-inspection-base AS computer-runtime
COPY skills-requirements.txt /opt/qubicl/skills-requirements.txt
COPY SKILLS_THIRD_PARTY_NOTICES.txt /usr/share/doc/qubicl/
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      mousepad \
      nano \
      openssh-client \
      openssh-server \
      python3-pip \
      thunar \
      vim \
      xfce4-panel \
      xfce4-session \
      xfce4-settings \
      xfce4-terminal \
      xfdesktop4 \
      xfwm4 \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/ssh/ssh_host_*_key* \
 && python3 -m venv /opt/qubicl/skills-venv \
 && /opt/qubicl/skills-venv/bin/pip install --no-cache-dir --requirement /opt/qubicl/skills-requirements.txt \
 && install -d /usr/share/doc/qubicl/skills-python-licenses \
 && find /opt/qubicl/skills-venv/lib -type f \( -iname 'LICENSE*' -o -iname 'COPYING*' \) \
      -exec cp --parents '{}' /usr/share/doc/qubicl/skills-python-licenses/ \; \
 && find /opt/qubicl/skills-venv -type d -name __pycache__ -prune -exec rm -rf '{}' + \
 && chown -R qubicl:qubicl /opt/qubicl/skills-venv

FROM computer-runtime AS workstation-runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      iproute2 \
      libreoffice \
      netcat-openbsd \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -m 0755 /etc/skel/.config/libreoffice/4/user

COPY libreoffice-registrymodifications.xcu /etc/skel/.config/libreoffice/4/user/registrymodifications.xcu

FROM filesystem-base AS file-system
ARG QUBICL_MANIFEST_SHA256
ARG QUBICL_CONTRACT_PRESET
ARG QUBICL_CONTRACT_COMPATIBILITY
ARG QUBICL_CONTRACT_CAPABILITIES
COPY --chown=qubicl:qubicl manifests/file-system.json /opt/qubicl/computer-manifest.json
ENV QUBICL_IMAGE_STARTUP_PROFILE=file-system
LABEL dev.qubicl.contract-version="1" \
      dev.qubicl.preset="$QUBICL_CONTRACT_PRESET" \
      dev.qubicl.compatibility="$QUBICL_CONTRACT_COMPATIBILITY" \
      dev.qubicl.capabilities="$QUBICL_CONTRACT_CAPABILITIES" \
      dev.qubicl.manifest-sha256="$QUBICL_MANIFEST_SHA256"
EXPOSE 3212

FROM browser-runtime AS browser
ARG QUBICL_MANIFEST_SHA256
ARG QUBICL_CONTRACT_PRESET
ARG QUBICL_CONTRACT_COMPATIBILITY
ARG QUBICL_CONTRACT_CAPABILITIES
COPY --chown=qubicl:qubicl manifests/browser.json /opt/qubicl/computer-manifest.json
ENV QUBICL_IMAGE_STARTUP_PROFILE=browser \
    QUBICL_IMAGE_VIEWER_AUTHENTICATION=header-v1
LABEL dev.qubicl.contract-version="1" \
      dev.qubicl.preset="$QUBICL_CONTRACT_PRESET" \
      dev.qubicl.compatibility="$QUBICL_CONTRACT_COMPATIBILITY" \
      dev.qubicl.capabilities="$QUBICL_CONTRACT_CAPABILITIES" \
      dev.qubicl.viewer-authentication="header-v1" \
      dev.qubicl.manifest-sha256="$QUBICL_MANIFEST_SHA256"
EXPOSE 3212 6080 6081

FROM computer-runtime AS computer
ARG QUBICL_MANIFEST_SHA256
ARG QUBICL_CONTRACT_PRESET
ARG QUBICL_CONTRACT_COMPATIBILITY
ARG QUBICL_CONTRACT_CAPABILITIES
COPY --chown=qubicl:qubicl manifests/computer.json /opt/qubicl/computer-manifest.json
ENV QUBICL_IMAGE_STARTUP_PROFILE=desktop \
    QUBICL_IMAGE_VIEWER_AUTHENTICATION=header-v1
LABEL dev.qubicl.contract-version="1" \
      dev.qubicl.preset="$QUBICL_CONTRACT_PRESET" \
      dev.qubicl.compatibility="$QUBICL_CONTRACT_COMPATIBILITY" \
      dev.qubicl.capabilities="$QUBICL_CONTRACT_CAPABILITIES" \
      dev.qubicl.viewer-authentication="header-v1" \
      dev.qubicl.manifest-sha256="$QUBICL_MANIFEST_SHA256"
EXPOSE 3212 6080 6081

FROM workstation-runtime AS workstation
ARG QUBICL_MANIFEST_SHA256
ARG QUBICL_CONTRACT_PRESET
ARG QUBICL_CONTRACT_COMPATIBILITY
ARG QUBICL_CONTRACT_CAPABILITIES
COPY --chown=qubicl:qubicl manifests/workstation.json /opt/qubicl/computer-manifest.json
ENV QUBICL_IMAGE_STARTUP_PROFILE=workstation \
    QUBICL_IMAGE_VIEWER_AUTHENTICATION=header-v1
LABEL dev.qubicl.contract-version="1" \
      dev.qubicl.preset="$QUBICL_CONTRACT_PRESET" \
      dev.qubicl.compatibility="$QUBICL_CONTRACT_COMPATIBILITY" \
      dev.qubicl.capabilities="$QUBICL_CONTRACT_CAPABILITIES" \
      dev.qubicl.viewer-authentication="header-v1" \
      dev.qubicl.manifest-sha256="$QUBICL_MANIFEST_SHA256"
EXPOSE 3212 6080 6081
