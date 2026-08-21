# `nix-shell` here is what a Nix-managed JS project gives its developers, and
# is the environment this E2E exercises.
let
  pkgs = import ./nixpkgs.nix;
in
pkgs.mkShell {
  packages = [ pkgs.nodejs_22 ];
}
