"""Adapter for a single, pre-authenticated proxy gateway (a paid rotating-
proxy provider — Decodo and similar services work this way): one fixed
endpoint with embedded credentials, where the provider's own infrastructure
rotates the exit IP per request/session server-side.

Implements the same interface ProxyPool exposes to core/downloader.py
(get_next/mark_working/mark_failed/mark_slow) so the download engine never
needs to know which kind of source it's talking to — but unlike ProxyPool,
there's nothing here to fetch, validate, or blacklist: the provider is
trusted to manage its own pool's health, and there's no fallback endpoint
to rotate to locally anyway. mark_failed/mark_slow are no-ops on purpose,
not oversights — blacklisting the only endpoint you have would just make
every job fail outright instead of retrying through it (a fresh connection
through a rotating gateway typically gets a new exit IP on its own).
"""


class GatewayProxyPool:
    def __init__(self, proxy_url):
        self._proxy_url = proxy_url

    def get_next(self):
        return self._proxy_url

    def mark_working(self, proxy):
        pass

    def mark_failed(self, proxy):
        pass

    def mark_slow(self, proxy):
        pass
