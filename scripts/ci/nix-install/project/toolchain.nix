# The Node the developer shell provides, buildable on its own so a provisioner
# can put it on PATH: `nix-build toolchain.nix -o /tmp/nix-node`. Its prefix —
# and therefore npm's global prefix — is a read-only store path.
(import ./nixpkgs.nix).nodejs_22
