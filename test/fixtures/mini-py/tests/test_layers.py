LAYER = {"core": 1, "util": 1, "app": 2, "web": 3}
ALLOWED = {("core", "app.models")}


def test_placeholder():
    assert LAYER
