# Single nixpkgs pin, shared by the developer shell and by the toolchain the
# E2E provisioners build. A release channel is used rather than a GitHub flake
# ref because the channel tarball is served from the NixOS CDN, which does not
# rate-limit CI the way codeload.github.com does.
import (fetchTarball {
  url = "https://channels.nixos.org/nixos-24.11/nixexprs.tar.xz";
}) { }
