INIT_URL = "https://gemini.google.com/app"
GENERATE_URL = (
    "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate"
)
BUILD_LABEL = "boq_assistant-bard-web-server_20260525.0"

MODEL_HEADER_KEY = "x-goog-ext-525001261-jspb"

DEFAULT_HEADERS = {
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    "origin": "https://gemini.google.com",
    "referer": "https://gemini.google.com/",
    "user-agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    ),
    "x-same-domain": "1",
}


def build_model_header(internal_id: str, capacity_tail: int = 1) -> dict[str, str]:
    return {
        MODEL_HEADER_KEY: (
            f'[1,null,null,null,"{internal_id}",null,null,0,[4],null,null,{capacity_tail}]'
        ),
        "x-goog-ext-73010989-jspb": "[0]",
        "x-goog-ext-73010990-jspb": "[0]",
    }


# Public model id -> internal Gemini web hash + label
MODEL_REGISTRY: dict[str, dict[str, object]] = {
    "unspecified": {"label": "Auto", "header": {}},
    "gemini-2.0-flash": {
        "label": "Gemini 2.0 Flash",
        "header": build_model_header("fbb127bbb056c959", 1),
    },
    "gemini-2.0-flash-thinking": {
        "label": "Gemini 2.0 Flash Thinking",
        "header": build_model_header("5bf011840784117a", 1),
    },
    "gemini-2.5-flash": {
        "label": "Gemini 2.5 Flash",
        "header": build_model_header("56fdd199312815e2", 1),
    },
    "gemini-2.5-flash-lite": {
        "label": "Gemini 2.5 Flash Lite",
        "header": build_model_header("fbb127bbb056c959", 1),
    },
    "gemini-2.5-pro": {
        "label": "Gemini 2.5 Pro",
        "header": build_model_header("9d8ca3786ebdfbea", 1),
    },
    "gemini-2.5-pro-deep-research": {
        "label": "Gemini 2.5 Pro Deep Research",
        "header": build_model_header("e6fa609c3fa255c0", 2),
    },
    "gemini-3-pro": {
        "label": "Gemini 3 Pro",
        "header": build_model_header("9d8ca3786ebdfbea", 1),
    },
    "gemini-3-flash": {
        "label": "Gemini 3 Flash",
        "header": build_model_header("fbb127bbb056c959", 1),
    },
    "gemini-3-flash-thinking": {
        "label": "Gemini 3 Flash Thinking",
        "header": build_model_header("5bf011840784117a", 1),
    },
}

MODELS = [{"id": model_id, "label": str(meta["label"])} for model_id, meta in MODEL_REGISTRY.items()]
