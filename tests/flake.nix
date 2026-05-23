{
  description = "wispy integration test — produces a uniquely-salted derivation per run";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAll (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          salt = builtins.getEnv "WISPY_TEST_SALT";
        in
        {
          default = pkgs.runCommand "wispy-test-${salt}" { } ''
            mkdir -p $out
            echo "salt=${salt}" > $out/marker
            date -u > $out/built-at
          '';
        });
    };

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
}
