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

    def _ast(variant: str):
        def factory():
            from .ast import AstAudioSet

            return AstAudioSet(variant=variant)

        return factory

    registry.register("ast:music_only", _ast("music_only"))
    registry.register("ast:music_group", _ast("music_group"))

    def _clap():
        from .clap import ClapZeroShot

        return ClapZeroShot()

    registry.register("clap_zeroshot:default", _clap)

    def _yamnet(variant: str):
        def factory():
            from .yamnet import Yamnet

            return Yamnet(variant=variant)

        return factory

    registry.register("yamnet:music_only", _yamnet("music_only"))
    registry.register("yamnet:music_group", _yamnet("music_group"))

    def _ina():
        from .ina import InaSegmenter

        return InaSegmenter()

    registry.register("ina_segmenter:default", _ina)


_register_all()
