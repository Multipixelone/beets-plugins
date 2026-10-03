# Adapted from Mikilio/nur-packages; see ../LICENSE.nur.
{
  lib,
  fetchFromGitHub,
  stdenv,
  python3,
  pkg-config,
  waf,
  eigen,
  libyaml,
  fftwFloat,
  ffmpeg_4,
  libsamplerate,
  taglib,
  chromaprint,
  gaia,
  qt5,
  zlib,
}:
let
  py3 = python3.withPackages (ps: [ ps.numpy ps.distutils ]);
in
stdenv.mkDerivation rec {
  pname = "essentia";
  version = "2.1_beta5";

  src = fetchFromGitHub {
    owner = "MTG";
    repo = "essentia";
    tag = "v${version}";
    hash = "sha256-nPw3KxN2vXgAGnQIC5pMxZ35hbveERmvzMLn7vgx4kU=";
  };

  patches = [
    ./0001-Replace-is-not-by-for-literals.patch
    ./0002-replace-waf-node-object-with-string.patch
    ./0003-add-eigen-to-includes.patch
    ./0004-replace-hardcoded-path-with-prefix.patch
  ];

  nativeBuildInputs = [ pkg-config (waf.override { python3 = py3; }).hook ];
  buildInputs = [
    py3 eigen libyaml fftwFloat ffmpeg_4 libsamplerate taglib chromaprint gaia
    qt5.qtbase qt5.qttools zlib
  ];
  wafPath = "buildtools/bin/waf";
  # High-level beta5 histories require Gaia; the prebuilt beta2 extractor lacks it.
  wafConfigureFlags = "--build-static --with-examples --with-gaia";
  dontWrapQtApps = true;

  meta = {
    description = "Audio analysis extractors with Gaia support for beta5 SVM models";
    homepage = "https://essentia.upf.edu";
    license = lib.licenses.agpl3Plus;
    maintainers = with lib.maintainers; [ Multipixelone ];
  };
}
