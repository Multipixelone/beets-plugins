{ lib, buildNpmPackage, python3, makeWrapper, worker ? null }:
buildNpmPackage {
  pname = "beets-album-graph";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json ./package-lock.json ./build.mjs ./app.mjs ./worker.mjs
      ./logic.mjs ./sound.mjs ./covers.mjs ./atlas.mjs ./cosmos-atlas-patch.mjs ./cosmos-vibe.mjs ./vibe.mjs ./gather.mjs ./physics.mjs ./visibility.mjs ./search.mjs ./index.html ./style.css ./server.py ./text_query.py ./tests
    ];
  };
  npmDepsHash = "sha256-rMjW7mYkrkOusOpbdTTwvwA5GET9/mECayN03DPMteQ=";
  nativeBuildInputs = [ makeWrapper ];
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    ${python3}/bin/python3 -m unittest discover -s tests -v
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/beets-album-graph $out/libexec $out/bin
    cp -r dist/. $out/share/beets-album-graph/
    cp server.py $out/libexec/beets-album-graph.py
    cp text_query.py $out/libexec/
    makeWrapper ${python3}/bin/python3 $out/bin/beets-album-graph \
      --add-flags "$out/libexec/beets-album-graph.py --assets $out/share/beets-album-graph" \
      ${lib.optionalString (worker != null) ''--add-flags "--text-worker ${worker}/bin/beets-embed-worker"''}
    runHook postInstall
  '';
  meta = {
    description = "Interactive GPU album similarity graph for beets embeddings";
    license = lib.licenses.agpl3Plus;
    maintainers = with lib.maintainers; [ Multipixelone ];
    mainProgram = "beets-album-graph";
  };
}
