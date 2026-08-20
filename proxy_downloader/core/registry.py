"""Registry that lets the CLI find providers by name or auto-detect one from a URL."""

_providers = {}
_default_name = None


def register(provider):
    global _default_name
    _providers[provider.name] = provider
    if provider.is_default:
        _default_name = provider.name
    return provider


def get(name):
    return _providers.get(name)


def all_providers():
    return list(_providers.values())


def detect(line):
    """Find the provider that owns `line` (by domain). Falls back to the
    default provider if none matches and the line looks like a bare ID
    or a default-provider shorthand (e.g. "l:FOLDERID")."""
    for provider in _providers.values():
        if provider.owns(line):
            return provider
    default = _providers.get(_default_name)
    if default and (default.extract_file_id(line) or default.extract_folder_id(line)):
        return default
    return None


def default_provider():
    return _providers.get(_default_name)
