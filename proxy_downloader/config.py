"""Constants shared by the proxy backend and the generic download engine.

Site-specific values (base URLs, endpoints, etc.) do NOT belong here — they
live on each provider in proxy_downloader/sites/.
"""
import re

PROXIES_URL        = "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/all/data.txt"
CACHE_FILE          = "working_proxies.json"
TIMEOUT             = 10
VALIDATION_TIMEOUT  = 3
MAX_VAL_THREADS     = 300
MAX_CHECK_THREADS   = 32
MIN_SPEED_KB        = 1500
PERMANENT_FAIL      = {404, 410, 403}
PROXY_REFRESH_WAIT  = 300
CACHE_MAX_AGE       = 600
MIN_CACHE_SIZE      = 10

IP_PORT_RE    = re.compile(r'^(?:(?P<scheme>https?|socks5?|socks4)://)?(?P<host>[^:/\s]+):(?P<port>\d{1,5})$', re.I)
INVALID_CHARS = re.compile(r'[<>:"/\\|?*]')
