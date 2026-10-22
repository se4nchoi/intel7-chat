"""Madi accepts classroom artifacts without serving active files inline."""
import pytest

from app.hub.uploads import safe_filename


@pytest.mark.parametrize("name", ["ladder.gwx", "ladder.gxw", "machine-config.vendorx", "lecture.pptx", "requirements.txt"])
def test_classroom_and_unknown_formats_are_accepted(name):
    assert safe_filename(name) == name


@pytest.mark.parametrize("name", ["malware.exe", "lesson.pdf.cmd", "page.html", "vector.svg", "script.js"])
def test_executable_and_active_web_formats_are_blocked(name):
    with pytest.raises(ValueError, match="cannot be shared"):
        safe_filename(name)


def test_filename_is_bounded_and_path_components_are_removed():
    assert safe_filename(r"C:\\Users\\Student\\ladder.gwx") == "ladder.gwx"
    assert safe_filename("../../ladder.gwx") == "ladder.gwx"
    assert safe_filename("<lesson>.gwx") == "lesson.gwx"
    assert safe_filename("report\u202Eexe.gwx") == "reportexe.gwx"
    assert len(safe_filename("long" * 100 + ".gwx")) <= 180
