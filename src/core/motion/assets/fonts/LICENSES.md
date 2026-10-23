# Bundled Font Licenses

These font files are bundled under their original free licenses for use by the
SuperAgent Studio declarative motion renderer. Each file is the Latin subset
served by Fontsource (https://fontsource.org) from the Google Fonts project.
All families are licensed under the SIL Open Font License 1.1 (full text in
`OFL-1.1.txt`), which permits commercial use, bundling and redistribution as
long as the license accompanies the files.

| Family | Weight | Upstream |
|---|---|---|
| Inter | 400 | https://github.com/rsms/inter |
| Space Grotesk | 500 | https://github.com/floriankarsten/space-grotesk |
| Montserrat | 700 | https://github.com/JulietaUla/Montserrat |
| Poppins | 600 | https://github.com/itfoundry/Poppins |
| Oswald | 500 | https://github.com/googlefonts/OswaldFont |
| Anton | 400 | https://github.com/googlefonts/AntonFont |
| Bebas Neue | 400 | https://github.com/googlefonts/BebasNeue |
| Archivo Black | 400 | https://github.com/Omnibus-Type/ArchivoBlack |
| Bungee | 400 | https://github.com/googlefonts/bungee |
| Playfair Display | 700 | https://github.com/clauseggers/Playfair-Display |
| Merriweather | 400 | https://github.com/SorkinType/Merriweather |
| JetBrains Mono | 400 | https://github.com/JetBrains/JetBrainsMono |
| Caveat | 500 | https://github.com/googlefonts/Caveat |
| Press Start 2P | 400 | https://github.com/googlefonts/PressStart2P |

The renderer registers these files under fixed family aliases only (see
`../motionFonts.ts` and `../schema/fontCatalog.ts`); scenes still cannot load
arbitrary user fonts, URLs, or host files.

Note: when running from a compiled `dist/` build without these assets, the
fonts silently degrade to the platform fallback instead of failing a render.
