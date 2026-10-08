"""Write src/assets/self-test-model.onnx, a stand-in for BiRefNet in tests.

It has BiRefNet's input and output (1x3x1024x1024 -> 1x1x1024x1024) and
answers "darker than the background is the subject": logits = -mean(RGB).
Tests and the packaged self-test use it so they run without the 224 MB /
973 MB download. Needs the `onnx` package:  pip install onnx
"""
import os
import onnx
from onnx import helper, TensorProto

x = helper.make_tensor_value_info("input_image", TensorProto.FLOAT, [1, 3, 1024, 1024])
y = helper.make_tensor_value_info("output_image", TensorProto.FLOAT, [1, 1, 1024, 1024])
mean = helper.make_node("ReduceMean", ["input_image"], ["mean"], axes=[1], keepdims=1)
neg = helper.make_node("Neg", ["mean"], ["output_image"])
graph = helper.make_graph([mean, neg], "tiny-darker-is-subject", [x], [y])
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="removebg-tests")
model.ir_version = 8
onnx.checker.check_model(model)
out = os.path.join(os.path.dirname(__file__), "..", "src", "assets", "self-test-model.onnx")
onnx.save(model, out)
print("wrote", os.path.normpath(out), os.path.getsize(out), "bytes")
