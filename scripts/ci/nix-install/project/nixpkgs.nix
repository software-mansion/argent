# Single nixpkgs pin, shared by the developer shell and by the toolchain the
# E2E provisioners build. Served from the NixOS CDN rather than a GitHub flake
# ref, which rate-limits CI; and named by release rather than by channel, so
# the nodejs the scenarios run against cannot change without this file changing.
import (fetchTarball {
  url = "https://releases.nixos.org/nixos/24.11/nixos-24.11.719113.50ab793786d9/nixexprs.tar.xz";
}) { }
