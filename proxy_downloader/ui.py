"""Shared console instance so every module prints through the same Rich console."""
from rich.console import Console

console = Console()
