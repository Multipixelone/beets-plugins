# Adapted from Mikilio/nur-packages; see LICENSE.nur.
{
  lib,
  fetchFromGitHub,
  stdenv,
  pkg-config,
  wafHook,
  eigen,
  libyaml,
  swig,
  qt5,
}:
stdenv.mkDerivation {
  pname = "gaia";
  version = "2.4.6-unstable";

  src = fetchFromGitHub {
    owner = "MTG";
    repo = "gaia";
    rev = "0d0942bf4748b40069977702715454ae084063c9";
    hash = "sha256-QK0xYCKmEigRjoP5abkxPtIGougy6WguFcLBJDJ71S4=";
  };

  nativeBuildInputs = [ pkg-config wafHook ];
  buildInputs = [ qt5.qtbase qt5.qttools eigen libyaml swig ];
  wafPath = "buildtools/bin/waf";
  # Do not enable --with-stlfacade: Essentia needs the Qt-based Gaia API.
  dontWrapQtApps = true;

  meta = {
    description = "Similarity and classification library for Essentia SVM models";
    homepage = "https://github.com/MTG/gaia";
    license = lib.licenses.agpl3Plus;
    maintainers = with lib.maintainers; [ Multipixelone ];
  };
}
