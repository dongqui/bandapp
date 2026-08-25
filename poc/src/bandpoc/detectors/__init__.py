"""Importing this package registers every detector.

Factories are lambdas so a backend that is not installed costs nothing until
someone actually asks for it.
"""

from .. import registry


def _register_all() -> None:
    from .dsp import DspBaseline

    registry.register("dsp_baseline:default", DspBaseline)


_register_all()
