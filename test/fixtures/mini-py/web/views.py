from app.service import run
from .helpers import h


def render():
    return h(run())
