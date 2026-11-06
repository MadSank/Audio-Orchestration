"""Export Beat This! `small0` to ONNX for the phone's on-device analysis (saics-player assets).

Run once from `engine/`, in the venv with `onnx` installed:
    python tools/export_beat_model.py <out.onnx>
The model takes a (1, frames, 128) log-mel spectrogram (see saics.lite.log_mel) and returns beat
and downbeat logits per frame (50 frames/s).
"""

import sys

import torch
from beat_this.inference import load_model


class Wrapper(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, spect):
        out = self.model(spect)
        return out["beat"], out["downbeat"]


def main(path: str) -> None:
    model = Wrapper(load_model("small0", "cpu")).eval()
    dummy = torch.zeros(1, 1500, 128)
    torch.onnx.export(
        model, (dummy,), path, opset_version=17, dynamo=False,
        input_names=["spect"], output_names=["beat", "downbeat"],
        dynamic_axes={"spect": {1: "frames"}, "beat": {1: "frames"}, "downbeat": {1: "frames"}},
    )  # fmt: skip
    print("wrote", path)


if __name__ == "__main__":
    main(sys.argv[1])
