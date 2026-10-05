"""Language table shared by every stage.

Codes are Whisper's ISO-639-1 style codes ("en", "yo", "yue"). Extra languages
that Whisper cannot recognise (Igbo "ig", Nigerian Pidgin "pcm") are included
because other providers can handle them.

The STT quality grades are *prior estimates* for Whisper large-v3 taken from
published FLEURS/Common Voice WER figures, bucketed coarsely:
    good  : WER roughly < 12 %
    fair  : roughly 12-35 %
    poor  : > 35 % (usable for gist captions only)
They are replaced by measured numbers once `scripts/bench.py` has been run on
real clips (see docs/LANGUAGES.md).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Language:
    code: str
    name: str
    whisper: bool            # Whisper can recognise / detect it
    flores: str | None       # NLLB-200 code (None = not in NLLB)
    stt_grade: str           # good | fair | poor | none (Whisper large-v3 prior)
    mms_iso3: str | None = None  # Meta MMS TTS/ASR code
    rtl: bool = False
    notes: str = ""


# fmt: off
_RAW: list[tuple] = [
    # code, name, whisper, flores, grade, mms_iso3
    ("en", "English", True, "eng_Latn", "good", "eng"),
    ("zh", "Chinese (Mandarin)", True, "zho_Hans", "good", None),
    ("de", "German", True, "deu_Latn", "good", "deu"),
    ("es", "Spanish", True, "spa_Latn", "good", "spa"),
    ("ru", "Russian", True, "rus_Cyrl", "good", "rus"),
    ("ko", "Korean", True, "kor_Hang", "good", "kor"),
    ("fr", "French", True, "fra_Latn", "good", "fra"),
    ("ja", "Japanese", True, "jpn_Jpan", "good", None),
    ("pt", "Portuguese", True, "por_Latn", "good", "por"),
    ("tr", "Turkish", True, "tur_Latn", "good", "tur"),
    ("pl", "Polish", True, "pol_Latn", "good", "pol"),
    ("ca", "Catalan", True, "cat_Latn", "good", "cat"),
    ("nl", "Dutch", True, "nld_Latn", "good", "nld"),
    ("ar", "Arabic", True, "arb_Arab", "fair", "ara"),
    ("sv", "Swedish", True, "swe_Latn", "good", "swe"),
    ("it", "Italian", True, "ita_Latn", "good", "ita"),
    ("id", "Indonesian", True, "ind_Latn", "good", "ind"),
    ("hi", "Hindi", True, "hin_Deva", "fair", "hin"),
    ("fi", "Finnish", True, "fin_Latn", "good", "fin"),
    ("vi", "Vietnamese", True, "vie_Latn", "good", "vie"),
    ("he", "Hebrew", True, "heb_Hebr", "fair", "heb"),
    ("uk", "Ukrainian", True, "ukr_Cyrl", "good", "ukr"),
    ("el", "Greek", True, "ell_Grek", "good", "ell"),
    ("ms", "Malay", True, "zsm_Latn", "good", "zlm"),
    ("cs", "Czech", True, "ces_Latn", "good", "ces"),
    ("ro", "Romanian", True, "ron_Latn", "good", "ron"),
    ("da", "Danish", True, "dan_Latn", "good", "dan"),
    ("hu", "Hungarian", True, "hun_Latn", "good", "hun"),
    ("ta", "Tamil", True, "tam_Taml", "fair", "tam"),
    ("no", "Norwegian", True, "nob_Latn", "good", "nob"),
    ("th", "Thai", True, "tha_Thai", "good", "tha"),
    ("ur", "Urdu", True, "urd_Arab", "fair", "urd"),
    ("hr", "Croatian", True, "hrv_Latn", "good", "hrv"),
    ("bg", "Bulgarian", True, "bul_Cyrl", "good", "bul"),
    ("lt", "Lithuanian", True, "lit_Latn", "fair", "lit"),
    ("la", "Latin", True, None, "fair", None),
    ("mi", "Maori", True, "mri_Latn", "poor", "mri"),
    ("ml", "Malayalam", True, "mal_Mlym", "poor", "mal"),
    ("cy", "Welsh", True, "cym_Latn", "fair", "cym"),
    ("sk", "Slovak", True, "slk_Latn", "good", "slk"),
    ("te", "Telugu", True, "tel_Telu", "poor", "tel"),
    ("fa", "Persian", True, "pes_Arab", "fair", "fas"),
    ("lv", "Latvian", True, "lvs_Latn", "fair", "lav"),
    ("bn", "Bengali", True, "ben_Beng", "fair", "ben"),
    ("sr", "Serbian", True, "srp_Cyrl", "fair", "srp"),
    ("az", "Azerbaijani", True, "azj_Latn", "fair", "azj"),
    ("sl", "Slovenian", True, "slv_Latn", "good", "slv"),
    ("kn", "Kannada", True, "kan_Knda", "poor", "kan"),
    ("et", "Estonian", True, "est_Latn", "fair", "est"),
    ("mk", "Macedonian", True, "mkd_Cyrl", "fair", "mkd"),
    ("br", "Breton", True, None, "poor", None),
    ("eu", "Basque", True, "eus_Latn", "fair", "eus"),
    ("is", "Icelandic", True, "isl_Latn", "fair", "isl"),
    ("hy", "Armenian", True, "hye_Armn", "fair", "hye"),
    ("ne", "Nepali", True, "npi_Deva", "poor", "npi"),
    ("mn", "Mongolian", True, "khk_Cyrl", "poor", "khk"),
    ("bs", "Bosnian", True, "bos_Latn", "fair", "bos"),
    ("kk", "Kazakh", True, "kaz_Cyrl", "fair", "kaz"),
    ("sq", "Albanian", True, "als_Latn", "fair", "sqi"),
    ("sw", "Swahili", True, "swh_Latn", "fair", "swh"),
    ("gl", "Galician", True, "glg_Latn", "good", "glg"),
    ("mr", "Marathi", True, "mar_Deva", "fair", "mar"),
    ("pa", "Punjabi", True, "pan_Guru", "poor", "pan"),
    ("si", "Sinhala", True, "sin_Sinh", "poor", "sin"),
    ("km", "Khmer", True, "khm_Khmr", "poor", "khm"),
    ("sn", "Shona", True, "sna_Latn", "poor", "sna"),
    ("yo", "Yoruba", True, "yor_Latn", "poor", "yor"),
    ("so", "Somali", True, "som_Latn", "poor", "som"),
    ("af", "Afrikaans", True, "afr_Latn", "fair", "afr"),
    ("oc", "Occitan", True, "oci_Latn", "poor", None),
    ("ka", "Georgian", True, "kat_Geor", "fair", "kat"),
    ("be", "Belarusian", True, "bel_Cyrl", "fair", "bel"),
    ("tg", "Tajik", True, "tgk_Cyrl", "poor", "tgk"),
    ("sd", "Sindhi", True, "snd_Arab", "poor", "snd"),
    ("gu", "Gujarati", True, "guj_Gujr", "poor", "guj"),
    ("am", "Amharic", True, "amh_Ethi", "poor", "amh"),
    ("yi", "Yiddish", True, "ydd_Hebr", "poor", "yid"),
    ("lo", "Lao", True, "lao_Laoo", "poor", "lao"),
    ("uz", "Uzbek", True, "uzn_Latn", "fair", "uzb"),
    ("fo", "Faroese", True, "fao_Latn", "poor", "fao"),
    ("ht", "Haitian Creole", True, "hat_Latn", "poor", "hat"),
    ("ps", "Pashto", True, "pbt_Arab", "poor", "pus"),
    ("tk", "Turkmen", True, "tuk_Latn", "poor", "tuk"),
    ("nn", "Norwegian Nynorsk", True, "nno_Latn", "fair", "nno"),
    ("mt", "Maltese", True, "mlt_Latn", "poor", "mlt"),
    ("sa", "Sanskrit", True, "san_Deva", "poor", None),
    ("lb", "Luxembourgish", True, "ltz_Latn", "poor", "ltz"),
    ("my", "Burmese", True, "mya_Mymr", "poor", "mya"),
    ("bo", "Tibetan", True, "bod_Tibt", "poor", "bod"),
    ("tl", "Tagalog", True, "tgl_Latn", "fair", "tgl"),
    ("mg", "Malagasy", True, "plt_Latn", "poor", "mlg"),
    ("as", "Assamese", True, "asm_Beng", "poor", "asm"),
    ("tt", "Tatar", True, "tat_Cyrl", "poor", "tat"),
    ("haw", "Hawaiian", True, None, "poor", "haw"),
    ("ln", "Lingala", True, "lin_Latn", "poor", "lin"),
    ("ha", "Hausa", True, "hau_Latn", "poor", "hau"),
    ("ba", "Bashkir", True, "bak_Cyrl", "poor", "bak"),
    ("jw", "Javanese", True, "jav_Latn", "poor", "jav"),
    ("su", "Sundanese", True, "sun_Latn", "poor", "sun"),
    ("yue", "Cantonese", True, "yue_Hant", "fair", None),
    # ---- not recognisable by Whisper; handled by other providers -----
    ("ig", "Igbo", False, "ibo_Latn", "none", "ibo"),
    ("pcm", "Nigerian Pidgin", False, None, "none", None),
]
# fmt: on

_RTL = {"ar", "he", "fa", "ur", "yi", "ps", "sd"}

_NOTES = {
    "yo": "Whisper WER is high and tone marks are often dropped; MMS-TTS expects tone-marked text.",
    "ha": "Whisper WER is high; translation via NLLB/MADLAD is usable.",
    "ig": "Not a Whisper language. Needs /mylang speak:ig plus the MMS Igbo ASR add-on or a cloud STT key.",
    "pcm": ("Not a Whisper language: transcribed as English (works because Pidgin is English-lexified). "
            "Not in NLLB, so translation *into* Pidgin needs an LLM. Spoken with an English voice."),
}

LANGUAGES: dict[str, Language] = {
    code: Language(code, name, wh, flores, grade, mms, code in _RTL, _NOTES.get(code, ""))
    for (code, name, wh, flores, grade, mms) in _RAW
}

WHISPER_CODES: frozenset[str] = frozenset(c for c, l in LANGUAGES.items() if l.whisper)

# Chatterbox Multilingual (v3) — zero-shot voice cloning languages.
CHATTERBOX_LANGS: frozenset[str] = frozenset(
    "ar da de el en es fi fr he hi it ja ko ms nl no pl pt ru sv sw tr zh".split()
)

# Piper language families with at least one published voice (static fallback;
# the Piper provider refreshes this from voices.json when it can).
PIPER_FAMILIES: frozenset[str] = frozenset(
    "ar bg bn ca cs cy da de el en es fa fi fr hi hu id is it ka kk lb lv ml ne nl no pl pt ro ru sk sl sr sv sw te tr uk vi zh".split()
)

# Preferred Piper voices (override in config.yaml). Unknown/missing names are
# resolved at runtime from voices.json, preferring medium quality.
PIPER_PREFERRED: dict[str, str] = {
    "en": "en_US-lessac-medium",
    "de": "de_DE-thorsten-medium",
    "es": "es_ES-davefx-medium",
    "fr": "fr_FR-siwis-medium",
    "it": "it_IT-paola-medium",
    "pt": "pt_BR-faber-medium",
    "nl": "nl_NL-mls-medium",
    "ru": "ru_RU-irina-medium",
    "uk": "uk_UA-ukrainian_tts-medium",
    "pl": "pl_PL-darkman-medium",
    "zh": "zh_CN-huayan-medium",
    "ar": "ar_JO-kareem-medium",
    "tr": "tr_TR-dfki-medium",
    "sv": "sv_SE-nst-medium",
    "sw": "sw_CD-lanfrica-medium",
    "vi": "vi_VN-vais1000-medium",
    "fa": "fa_IR-amir-medium",
    "ca": "ca_ES-upc_ona-medium",
    "cs": "cs_CZ-jirka-medium",
    "da": "da_DK-talesyntese-medium",
    "el": "el_GR-rapunzelina-medium",
    "fi": "fi_FI-harri-medium",
    "hu": "hu_HU-anna-medium",
    "no": "no_NO-talesyntese-medium",
    "ro": "ro_RO-mihai-medium",
}

# Groups of languages Whisper often confuses. Switching between members of the
# same group needs a larger, sustained margin (see lid.py).
CONFUSABLE_GROUPS: list[frozenset[str]] = [
    frozenset({"es", "pt", "gl", "ca"}),
    frozenset({"hi", "ur"}),
    frozenset({"id", "ms", "jw", "su"}),
    frozenset({"no", "nn", "da", "sv"}),
    frozenset({"sr", "hr", "bs", "mk", "sl"}),
    frozenset({"ru", "uk", "be", "bg"}),
    frozenset({"cs", "sk"}),
    frozenset({"zh", "yue"}),
    frozenset({"af", "nl"}),
    frozenset({"lb", "de"}),
    frozenset({"fa", "tg"}),
    frozenset({"en", "pcm"}),
]

# Pidgin marker words used by the transcript-level second-pass detector.
PIDGIN_MARKERS: frozenset[str] = frozenset(
    "dey wetin abeg una wahala sabi comot pikin oga chop wey dem don abi sef sha ehn shey nawa jare"
    " dis dat tok waka belle gbege kpatakpata ginger yarn".split()
)

GRADE_ORDER = {"good": 3, "fair": 2, "poor": 1, "none": 0}


def get(code: str) -> Language | None:
    return LANGUAGES.get(normalize(code))


def normalize(code: str | None) -> str:
    """Accept 'en-US', 'EN', 'eng_Latn', 'jv' etc. and map to our codes."""
    if not code:
        return ""
    c = code.strip().replace("_", "-")
    low = c.lower()
    if low in LANGUAGES:
        return low
    if low == "jv":
        return "jw"
    if low in ("iw",):
        return "he"
    if low in ("nb",):
        return "no"
    if low in ("zh-cn", "zh-hans", "cmn"):
        return "zh"
    if low in ("zh-hk", "zh-hant", "zh-tw") or low.startswith("yue"):
        return "yue" if "hk" in low or low.startswith("yue") else "zh"
    # flores code?
    for l in LANGUAGES.values():
        if l.flores and l.flores.lower() == low.replace("-", "_"):
            return l.code
    base = low.split("-")[0]
    if base in LANGUAGES:
        return base
    # iso3 via mms table
    for l in LANGUAGES.values():
        if l.mms_iso3 == base:
            return l.code
    return low


def confusable(a: str, b: str) -> bool:
    return any(a in g and b in g for g in CONFUSABLE_GROUPS)


def downgrade(grade: str, steps: int = 1) -> str:
    order = ["none", "poor", "fair", "good"]
    i = max(0, order.index(grade) - steps) if grade in order else 0
    return order[i]


def pidgin_score(text: str) -> float:
    """Fraction of tokens that are Nigerian Pidgin markers (0..1)."""
    toks = [t.strip(".,!?;:'\"()").lower() for t in text.split()]
    toks = [t for t in toks if t]
    if not toks:
        return 0.0
    hits = sum(1 for t in toks if t in PIDGIN_MARKERS)
    # "na" is a strong marker only when not followed by English "na" usage; count half
    hits += 0.5 * sum(1 for t in toks if t == "na")
    return hits / len(toks)


def display(code: str) -> str:
    l = get(code)
    return l.name if l else code
