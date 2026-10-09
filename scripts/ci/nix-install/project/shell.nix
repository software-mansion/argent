# What a Nix-managed JS project gives its developers, and the fixture each
# scenario copies into its own project directory. The scenarios do not enter it:
# the provisioner builds toolchain.nix and puts that on PATH, so this file is
# what the situation looks like, not what runs. Keep its Node in step with
# toolchain.nix — nothing evaluates this file, so nothing will catch a drift.
let
  pkgs = import ./nixpkgs.nix;
in
pkgs.mkShell {
  packages = [ pkgs.nodejs_22 ];
}
