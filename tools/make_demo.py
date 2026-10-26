"""Maintainer helper: package existing synthetic Potato test media only."""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / "potato_cloud_starter"
manifest = {
    "format": "trace-task-manifest", "schema_version": "1.0", "batch_id": "demo_batch",
    "assignment_id": "demo_A", "annotator_id": "ann01", "items": [
        {"id": "video_demo_1", "title": "合成测试视频", "media_path": "media/demo.mp4", "media_type": "video", "source_id": "synthetic_signal", "clip_start_s": 0, "duration_s": 12, "video_fps": 25, "text": "此素材为合成信号，无人物或真实讲话。标记任意区间并验证导出与恢复。"},
        {"id": "audio_demo_1", "title": "合成测试音频", "media_path": "media/demo.wav", "media_type": "audio", "source_id": "synthetic_signal", "clip_start_s": 0, "duration_s": 12.032, "text": "此素材仅用于验证播放、波形、区间标注与本地导出。"},
    ],
}
if __name__ == "__main__":
    target = ROOT / "samples/demo-task.zip"
    target.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("demo-task/tasks.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        archive.write(SOURCE / "project/media/demo.mp4", "demo-task/media/demo.mp4")
        archive.write(SOURCE / "project_audio/media/demo.wav", "demo-task/media/demo.wav")
    print(f"Synthetic demo package: {target.name} ({target.stat().st_size} bytes)")
