"""Importing this package registers every detector.

Factories are lambdas so a backend that is not installed costs nothing until
someone actually asks for it.
"""

from .. import registry


def _register_all() -> None:
    from .dsp import DspBaseline

    registry.register("dsp_baseline:default", DspBaseline)

    def _panns(variant: str):
        def factory():
            from .panns import PannsCnn14

            return PannsCnn14(variant=variant)

        return factory

    registry.register("panns_cnn14:music_only", _panns("music_only"))
    registry.register("panns_cnn14:music_group", _panns("music_group"))

    def _silero():
        from .silero import SileroVad

        return SileroVad()

    registry.register("silero_vad:default", _silero)


_register_all()
