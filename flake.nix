{
  description = "wispy — drop-in GitHub Action: Nix binary cache on Cloudflare R2";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: {
        default = pkgs.buildNpmPackage {
          pname = "wispy";
          version = "0.1.0";
          src = ./.;
          npmDepsHash = "sha256-5ajSbNvwAIOJGcUuHrBMKCRtvZb3IxceOFOGwtzdksc=";
          nodejs = pkgs.nodejs_24;

          # `npm run build` (via npmBuildHook) emits dist/{main,post,uploader}/index.js.
          # Ship those bundles plus action.yml and scripts/ so $out is a complete,
          # GitHub-Actions-runnable copy of the action.
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp -r dist $out/
            cp action.yml $out/
            cp -r scripts $out/
            runHook postInstall
          '';

          meta = {
            description = "Drop-in GitHub Action: Nix binary cache on Cloudflare R2";
            homepage = "https://github.com/nicolaschan/wispy";
            license = nixpkgs.lib.licenses.mit;
            platforms = nixpkgs.lib.platforms.linux;
          };
        };
      });

      devShells = forAll (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = [
            pkgs.nodejs_24
            pkgs.nodePackages.wrangler
            pkgs.gh
            pkgs.shellcheck
            pkgs.jq
            pkgs.git
          ];
        };
      });

      formatter = forAll (pkgs: pkgs.nixpkgs-fmt);
    };
}
