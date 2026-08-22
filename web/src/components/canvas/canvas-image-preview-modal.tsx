import { useEffect, useState } from "react";
import { Button, Modal, Tooltip } from "antd";
import { Maximize, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readImageMeta } from "@/lib/image-utils";
import { useImageEditorViewport } from "./use-image-editor-viewport";

type ImageSize = { width: number; height: number };

type CanvasImagePreviewModalProps = {
    src: string;
    title: string;
    open: boolean;
    onClose: () => void;
    naturalWidth?: number;
    naturalHeight?: number;
};

export function CanvasImagePreviewModal({ src, title, open, onClose, naturalWidth, naturalHeight }: CanvasImagePreviewModalProps) {
    const { t } = useTranslation();
    const [image, setImage] = useState<ImageSize | null>(null);
    const viewport = useImageEditorViewport(image, open);

    useEffect(() => {
        if (!open || !src) return;
        if (naturalWidth && naturalHeight) {
            setImage({ width: naturalWidth, height: naturalHeight });
            return;
        }
        setImage(null);
        void readImageMeta(src).then((meta) => setImage({ width: meta.width, height: meta.height }));
    }, [naturalHeight, naturalWidth, open, src]);

    return (
        <Modal
            title={title}
            open={open && Boolean(src)}
            centered
            onCancel={onClose}
            footer={null}
            width={1240}
            destroyOnHidden
            styles={{ body: { padding: 0 } }}
        >
            <div className="space-y-3" data-canvas-no-zoom>
                <div
                    ref={viewport.viewportRef}
                    {...viewport.panHandlers}
                    className={`relative isolate h-[min(72vh,760px)] min-h-[360px] rounded-lg bg-black/10 ${viewport.scrollClassName} ${viewport.isPanning ? "cursor-grabbing" : viewport.spacePressed ? "cursor-grab" : ""}`}
                >
                    <div className="relative" style={viewport.contentStyle}>
                        <div ref={viewport.stageRef} className="absolute isolate overflow-hidden rounded-md bg-black [backface-visibility:hidden] [contain:layout_paint] [transform:translateZ(0)]" style={viewport.stageStyle}>
                            <img src={src} alt={title} className="block h-full w-full select-none object-contain" style={viewport.mediaStyle} draggable={false} />
                        </div>
                    </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-1">
                    <div className="flex flex-wrap items-center gap-1">
                        <Tooltip title={t("canvas.editors.zoomOut")}>
                            <Button type="text" icon={<ZoomOut className="size-4" />} disabled={!viewport.canZoomOut} aria-label={t("canvas.editors.zoomOut")} onClick={viewport.zoomOut}>
                                {t("canvas.editors.zoomOut")}
                            </Button>
                        </Tooltip>
                        <span className="min-w-16 text-center text-xs font-semibold tabular-nums opacity-70">{Math.round(viewport.zoom * 100)}%</span>
                        <Tooltip title={t("canvas.editors.zoomIn")}>
                            <Button type="text" icon={<ZoomIn className="size-4" />} disabled={!viewport.canZoomIn} aria-label={t("canvas.editors.zoomIn")} onClick={viewport.zoomIn}>
                                {t("canvas.editors.zoomIn")}
                            </Button>
                        </Tooltip>
                        <Tooltip title={t("canvas.editors.fitWindow")}>
                            <Button type="text" icon={<Maximize className="size-4" />} aria-label={t("canvas.editors.fitWindow")} onClick={viewport.fitZoom}>
                                {t("canvas.editors.fitWindow")}
                            </Button>
                        </Tooltip>
                        <Tooltip title={t("canvas.editors.restore")}>
                            <Button type="text" icon={<RotateCcw className="size-4" />} aria-label={t("canvas.editors.restore")} onClick={viewport.actualSize}>
                                {t("canvas.editors.restore")}
                            </Button>
                        </Tooltip>
                    </div>
                    <span className="text-xs font-semibold opacity-60">{image ? `${image.width} x ${image.height} px` : t("canvas.editors.loading")}</span>
                </div>
            </div>
        </Modal>
    );
}
