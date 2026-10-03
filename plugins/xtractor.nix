{
  lib,
  beets,
  fetchFromGitHub,
  extractor,
  models,
  pythonPackages,
}:
let
  svmModels = [
    "danceability" "gender" "genre_rosamerica"
    "mood_acoustic" "mood_aggressive" "mood_electronic" "mood_happy"
    "mood_sad" "mood_party" "mood_relaxed" "voice_instrumental" "moods_mirex"
  ];
in
pythonPackages.buildPythonApplication rec {
  pname = "beets-xtractor";
  pyproject = true;
  build-system = [
    pythonPackages.setuptools
  ];
  version = "0.4.2";

  # PyPI 0.4.2 predates beets' library-relative paths; master fixes resolution.
  src = fetchFromGitHub {
    owner = "adamjakab";
    repo = "BeetsPluginXtractor";
    rev = "6aa5b6177a5593262894ec5a847fc426cc28641e";
    hash = "sha256-6g0ZGZAmlQ70iWm+erTdbWw+JOAm5DztwoXcFR6loFA=";
  };

  patches = [ ./xtractor/auto.patch ];

  postPatch = ''
    substituteInPlace beetsplug/xtractor/config_default.yml \
      --replace-fail /your/path/to/streaming_extractor_music ${extractor}/bin/essentia_streaming_extractor_music \
      --replace-fail "      - /your/path/to/svm_model.history" '${lib.concatMapStringsSep "\n" (model: "      - ${models}/${model}.history") svmModels}'
  '';

  # The final beets wrapper supplies the host. Propagating a second beets
  # derivation here conflicts with that wrapper's own distribution.
  nativeBuildInputs = [ beets ];
  dependencies = [ pythonPackages.pyyaml ];

  nativeCheckInputs = [ pythonPackages.pytestCheckHook ];
  # Upstream's old nose-based test harness uses removed beets internals.
  preCheck = ''
    cp ${./xtractor/tests/test_auto.py} test_auto.py
  '';
  pytestFlags = [ "test_auto.py" ];
  pythonImportsCheck = [ "beetsplug.xtractor" ];

  passthru = { inherit extractor models; };

  meta = with lib; {
    description = "A beets plugin to add low and high level musical information to songs.";
    homepage = "https://github.com/adamjakab/BeetsPluginXtractor";
    maintainers = with maintainers; [ johnhamelink ];
    license = licenses.mit;
  };
}
