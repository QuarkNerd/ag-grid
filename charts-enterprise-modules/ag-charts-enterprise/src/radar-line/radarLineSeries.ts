import {
    _ModuleSupport,
    _Scale,
    _Scene,
    _Util,
    AgPieSeriesFormatterParams,
    AgPieSeriesTooltipRendererParams,
    AgPieSeriesFormat,
    AgTooltipRendererResult,
} from 'ag-charts-community';

import {
    AgRadarLineSeriesLabelFormatterParams,
    AgRadarLineSeriesMarkerFormat,
    AgRadarLineSeriesMarkerFormatterParams,
} from './typings';

const {
    ChartAxisDirection,
    DataModel,
    HighlightStyle,
    NUMBER,
    OPT_COLOR_STRING,
    OPT_FUNCTION,
    OPT_LINE_DASH,
    OPT_STRING,
    STRING,
    SeriesNodePickMode,
    StateMachine,
    Validate,
    valueProperty,
} = _ModuleSupport;

const { BandScale, LinearScale } = _Scale;

const { Group, Path, PointerEvents, Selection, Text, getMarker, toTooltipHtml } = _Scene;
const { extent, interpolateString, isNumberEqual, sanitizeHtml, toFixed } = _Util;

class RadarLineSeriesNodeBaseClickEvent extends _ModuleSupport.SeriesNodeBaseClickEvent<any> {
    readonly angleKey: string;
    readonly radiusKey: string;

    constructor(
        angleKey: string,
        radiusKey: string,
        nativeEvent: MouseEvent,
        datum: RadarLineNodeDatum,
        series: RadarLineSeries
    ) {
        super(nativeEvent, datum, series);
        this.angleKey = angleKey;
        this.radiusKey = radiusKey;
    }
}

class RadarLineSeriesNodeClickEvent extends RadarLineSeriesNodeBaseClickEvent {
    readonly type = 'nodeClick';
}

class RadarLineSeriesNodeDoubleClickEvent extends RadarLineSeriesNodeBaseClickEvent {
    readonly type = 'nodeDoubleClick';
}

interface RadarLineNodeDatum extends _ModuleSupport.SeriesNodeDatum {
    readonly label?: {
        text: string;
        x: number;
        y: number;
        hAlign: CanvasTextAlign;
        vAlign: CanvasTextBaseline;
    };
}

class RadarLineSeriesLabel extends _Scene.Label {
    @Validate(OPT_FUNCTION)
    formatter?: (params: AgRadarLineSeriesLabelFormatterParams) => string = undefined;
}

class RadarLineSeriesTooltip extends _ModuleSupport.SeriesTooltip {
    @Validate(OPT_FUNCTION)
    renderer?: (params: AgPieSeriesTooltipRendererParams) => string | AgTooltipRendererResult = undefined;
    @Validate(OPT_STRING)
    format?: string = undefined;
}

export class RadarLineSeriesMarker extends _ModuleSupport.SeriesMarker {
    @Validate(OPT_FUNCTION)
    @_Scene.SceneChangeDetection({ redraw: _Scene.RedrawType.MAJOR })
    formatter?: (params: AgRadarLineSeriesMarkerFormatterParams<any>) => AgRadarLineSeriesMarkerFormat = undefined;
}

type RadarLineAnimationState = 'empty' | 'ready';
type RadarLineAnimationEvent = 'update';
class RadarLineStateMachine extends StateMachine<RadarLineAnimationState, RadarLineAnimationEvent> {}

export class RadarLineSeries extends _ModuleSupport.PolarSeries<RadarLineNodeDatum> {
    static className = 'RadarLineSeries';
    static type = 'radar-line' as const;

    readonly marker = new RadarLineSeriesMarker();

    readonly label = new RadarLineSeriesLabel();

    private radiusScale: _Scale.LinearScale = new LinearScale();

    private pathSelection: _Scene.Selection<_Scene.Path, boolean>;
    private markerSelection: _Scene.Selection<_Scene.Marker, RadarLineNodeDatum>;
    private labelSelection: _Scene.Selection<_Scene.Text, RadarLineNodeDatum>;
    private angleAxisSelection: _Scene.Selection<_Scene.Path, RadarLineNodeDatum>;
    private radiusAxisSelection: _Scene.Selection<_Scene.Path, boolean>;
    private highlightSelection: _Scene.Selection<_Scene.Marker, RadarLineNodeDatum>;

    private animationState: RadarLineStateMachine;

    private nodeData: RadarLineNodeDatum[] = [];
    private angleScale: _Scale.BandScale<string>;

    tooltip: RadarLineSeriesTooltip = new RadarLineSeriesTooltip();

    /**
     * The key of the numeric field to use to determine the angle (for example,
     * a pie sector angle).
     */
    @Validate(STRING)
    angleKey = '';

    @Validate(OPT_STRING)
    angleName?: string = undefined;

    /**
     * The key of the numeric field to use to determine the radii of pie sectors.
     * The largest value will correspond to the full radius and smaller values to
     * proportionally smaller radii.
     */
    @Validate(STRING)
    radiusKey: string = '';

    @Validate(OPT_STRING)
    radiusName?: string = undefined;

    @Validate(OPT_COLOR_STRING)
    stroke?: string = 'black';

    @Validate(NUMBER(0, 1))
    strokeOpacity = 1;

    @Validate(OPT_LINE_DASH)
    lineDash?: number[] = [0];

    @Validate(NUMBER(0))
    lineDashOffset: number = 0;

    @Validate(OPT_FUNCTION)
    formatter?: (params: AgPieSeriesFormatterParams<any>) => AgPieSeriesFormat = undefined;

    /**
     * The series rotation in degrees.
     */
    @Validate(NUMBER(-360, 360))
    rotation = 0;

    @Validate(NUMBER(0))
    strokeWidth = 1;

    readonly highlightStyle = new HighlightStyle();

    constructor(moduleCtx: _ModuleSupport.ModuleContext) {
        super({
            moduleCtx,
            useLabelLayer: true,
            pickModes: [SeriesNodePickMode.NEAREST_NODE, SeriesNodePickMode.EXACT_SHAPE_MATCH],
        });

        this.angleScale = new BandScale();
        // Each sector is a ratio of the whole, where all ratios add up to 1.
        this.angleScale.domain = [];
        // Add 90 deg to start the chart at 12 o'clock.
        this.angleScale.range = [-Math.PI / 2, (3 * Math.PI) / 2];

        const angleAxisGroup = new Group();
        this.contentGroup.append(angleAxisGroup);
        this.angleAxisSelection = Selection.select(angleAxisGroup, Path);

        const radiusAxisGroup = new Group();
        this.contentGroup.append(radiusAxisGroup);
        this.radiusAxisSelection = Selection.select(radiusAxisGroup, Path);

        const pathGroup = new Group();
        this.contentGroup.append(pathGroup);
        this.pathSelection = Selection.select(pathGroup, Path);

        const markerFactory = () => {
            const { shape } = this.marker;
            const MarkerShape = getMarker(shape);
            return new MarkerShape();
        };
        const markerGroup = new Group();
        this.contentGroup.append(markerGroup);
        this.markerSelection = Selection.select(markerGroup, markerFactory);

        this.labelSelection = Selection.select(this.labelGroup!, Text);

        this.highlightSelection = Selection.select(this.highlightGroup, markerFactory);

        this.animationState = new RadarLineStateMachine('empty', {
            empty: {
                on: {
                    update: {
                        target: 'ready',
                        action: () => this.animateEmptyUpdateReady(),
                    },
                },
            },
            ready: {
                on: {
                    update: {
                        target: 'ready',
                        action: () => this.animateUpdateReady(),
                    },
                },
            },
        });
        // TODO: To be deleted when animations are enabled (prevents TSLint warning).
        this.animationState.debug;
    }

    addChartEventListeners(): void {
        this.chartEventManager?.addListener('legend-item-click', (event) => this.onLegendItemClick(event));
        this.chartEventManager?.addListener('legend-item-double-click', (event) => this.onLegendItemDoubleClick(event));
    }

    getDomain(direction: _ModuleSupport.ChartAxisDirection): any[] {
        const { dataModel, processedData } = this;
        if (!processedData || !dataModel) return [];

        if (direction === ChartAxisDirection.X) {
            return dataModel.getDomain(`angleValue`, processedData);
        } else {
            const domain = dataModel.getDomain(`radiusValue`, processedData);
            return this.fixNumericExtent(extent([0].concat(domain)));
        }
    }

    async processData() {
        const { data = [] } = this;
        const { angleKey, radiusKey } = this;

        if (!angleKey || !radiusKey) return;

        this.dataModel = new DataModel<any, any, true>({
            props: [
                valueProperty(angleKey, false, { id: 'angleValue' }),
                valueProperty(radiusKey, false, { id: 'radiusValue', invalidValue: undefined }),
            ],
        });
        this.processedData = this.dataModel.processData(data);

        // TODO: Assign domain in radar axes.
        this.angleScale.domain = this.getDomain(_ModuleSupport.ChartAxisDirection.X);
        this.radiusScale.domain = this.getDomain(_ModuleSupport.ChartAxisDirection.Y);
    }

    maybeRefreshNodeData() {
        if (!this.nodeDataRefresh) return;
        const [{ nodeData = [] } = {}] = this._createNodeData();
        this.nodeData = nodeData;
        this.nodeDataRefresh = false;
    }

    async createNodeData() {
        return this._createNodeData();
    }

    private _createNodeData() {
        const { processedData, dataModel, angleKey, radiusKey } = this;

        if (!processedData || !dataModel || !angleKey || !radiusKey) {
            return [];
        }

        const angleIdx = dataModel.resolveProcessedDataIndexById(`angleValue`)?.index ?? -1;
        const radiusIdx = dataModel.resolveProcessedDataIndexById(`radiusValue`)?.index ?? -1;

        const { angleScale, radiusScale, label, marker, id: seriesId } = this;
        const { size: markerSize } = this.marker;

        const nodeData = processedData.data.map((group): RadarLineNodeDatum => {
            const { datum, values } = group;

            const angleDatum = values[angleIdx];
            const radiusDatum = values[radiusIdx];

            const angle = angleScale.convert(angleDatum);
            const radius = radiusScale.convert(radiusDatum);

            const cos = Math.cos(angle);
            const sin = Math.sin(angle);

            const x = this.centerX + cos * radius;
            const y = this.centerY + sin * radius;

            let labelNodeDatum: RadarLineNodeDatum['label'];
            if (label.enabled) {
                let labelText = '';
                if (label.formatter) {
                    labelText = label.formatter({ value: radiusDatum, seriesId });
                } else if (typeof radiusDatum === 'number' && isFinite(radiusDatum)) {
                    labelText = radiusDatum.toFixed(2);
                } else if (radiusDatum) {
                    labelText = String(radiusDatum);
                }
                if (labelText) {
                    const labelX = x + cos * marker.size;
                    const labelY = y + sin * marker.size;
                    labelNodeDatum = {
                        text: labelText,
                        x: labelX,
                        y: labelY,
                        hAlign: isNumberEqual(cos, 0) ? 'center' : cos > 0 ? 'left' : 'right',
                        vAlign: isNumberEqual(sin, 0) ? 'middle' : sin > 0 ? 'top' : 'bottom',
                    };
                }
            }

            return {
                series: this,
                datum,
                point: { x, y, size: markerSize },
                nodeMidPoint: { x, y },
                label: labelNodeDatum,
            };
        });

        return [{ itemId: radiusKey, nodeData, labelData: nodeData }];
    }

    updateRadiusScale(bbox: _Scene.BBox) {
        const radius = Math.min(bbox.width, bbox.height) / 2;
        this.radiusScale.range = [0, radius];
    }

    async update({ seriesRect }: { seriesRect: _Scene.BBox }) {
        this.updateRadiusScale(seriesRect);
        this.maybeRefreshNodeData();

        this.drawTempAxis();
        this.updatePath();
        this.updateMarkers(this.markerSelection, false);
        this.updateMarkers(this.highlightSelection, true);
        this.updateLabels();
    }

    private drawTempAxis() {
        const { visible } = this;
        const radius = this.radiusScale.range[1];
        const cx = this.centerX;
        const cy = this.centerY;
        this.angleAxisSelection.update(visible ? this.nodeData : []).each((node, datum) => {
            node.path.clear({ trackChanges: true });
            const angle = this.angleScale.convert(datum.datum[this.angleKey]);
            node.path.moveTo(cx, cy);
            node.path.lineTo(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
            node.stroke = 'gray';
            node.strokeWidth = 1;
            node.pointerEvents = PointerEvents.None;
        });
        this.radiusAxisSelection.update(visible ? [true] : []).each((node) => {
            node.path.clear({ trackChanges: true });
            node.path.moveTo(cx + radius, cy);
            node.path.arc(this.centerX, this.centerY, radius, 0, 2 * Math.PI);
            node.path.closePath();
            node.stroke = 'gray';
            node.strokeWidth = 1;
            node.fill = undefined;
            node.pointerEvents = PointerEvents.None;
        });
    }

    private updatePath() {
        this.pathSelection.update(this.visible ? [true] : []).each((node) => {
            const { path } = node;
            path.clear({ trackChanges: true });
            this.nodeData.forEach((datum, index) => {
                const point = datum.point!;
                if (index === 0) {
                    path.moveTo(point.x, point.y);
                } else {
                    path.lineTo(point.x, point.y);
                }
            });
            path.closePath();
            node.pointerEvents = PointerEvents.None;
            node.lineJoin = 'round';
            node.fill = undefined;
            node.stroke = this.stroke;
            node.strokeOpacity = this.strokeOpacity;
            node.strokeWidth = this.getStrokeWidth(this.strokeWidth);
        });
    }

    private updateMarkers(selection: _Scene.Selection<_Scene.Marker, RadarLineNodeDatum>, highlight: boolean) {
        const { marker, visible } = this;
        const { shape, enabled } = marker;
        let selectionData: RadarLineNodeDatum[] = [];
        if (visible && shape && enabled) {
            if (highlight) {
                const highlighted = this.highlightManager?.getActiveHighlight();
                if (highlighted?.datum) {
                    selectionData = [highlighted as RadarLineNodeDatum];
                }
            } else {
                selectionData = this.nodeData;
            }
        }
        const highlightedStyle = highlight ? this.highlightStyle.item : undefined;
        selection.update(selectionData).each((node, datum) => {
            node.fill = highlightedStyle?.fill ?? marker.fill;
            node.stroke = highlightedStyle?.stroke ?? marker.stroke;
            node.strokeWidth = highlightedStyle?.strokeWidth ?? marker.strokeWidth ?? 1;
            node.fillOpacity = highlightedStyle?.fillOpacity ?? marker.fillOpacity ?? 1;
            node.strokeOpacity = marker.strokeOpacity ?? 1;
            node.size = marker.size;

            const { x, y } = datum.point!;
            node.translationX = x;
            node.translationY = y;
            node.visible = node.size > 0 && !isNaN(x) && !isNaN(y);
        });
    }

    private updateLabels() {
        const { label, labelSelection } = this;
        labelSelection.update(this.nodeData).each((node, datum) => {
            if (label.enabled && datum.label) {
                node.x = datum.label.x;
                node.y = datum.label.y;

                node.fill = label.color;

                node.fontFamily = label.fontFamily;
                node.fontSize = label.fontSize;
                node.fontStyle = label.fontStyle;
                node.fontWeight = label.fontWeight;
                node.text = datum.label.text;
                node.textAlign = datum.label.hAlign;
                node.textBaseline = datum.label.vAlign;

                node.visible = true;
            } else {
                node.visible = false;
            }
        });
    }

    protected getNodeClickEvent(event: MouseEvent, datum: RadarLineNodeDatum): RadarLineSeriesNodeClickEvent {
        return new RadarLineSeriesNodeClickEvent(this.angleKey, this.radiusKey, event, datum, this);
    }

    protected getNodeDoubleClickEvent(
        event: MouseEvent,
        datum: RadarLineNodeDatum
    ): RadarLineSeriesNodeDoubleClickEvent {
        return new RadarLineSeriesNodeDoubleClickEvent(this.angleKey, this.radiusKey, event, datum, this);
    }

    getTooltipHtml(nodeDatum: RadarLineNodeDatum): string {
        const { angleKey, radiusKey } = this;

        if (!angleKey || !radiusKey) {
            return '';
        }

        const { angleName, radiusName, tooltip, marker, id: seriesId } = this;
        const { renderer: tooltipRenderer, format: tooltipFormat } = tooltip;
        const datum = nodeDatum.datum;
        const angleValue = datum[angleKey];
        const radiusValue = datum[radiusKey];
        const formattedAngleValue = typeof angleValue === 'number' ? toFixed(angleValue) : String(angleValue);
        const formattedRadiusValue = typeof radiusValue === 'number' ? toFixed(radiusValue) : String(radiusValue);
        const title = sanitizeHtml(radiusName);
        const content = sanitizeHtml(`${formattedAngleValue}: ${formattedRadiusValue}`);

        const { formatter: markerFormatter, fill, stroke, strokeWidth: markerStrokeWidth, size } = marker;
        const strokeWidth = markerStrokeWidth ?? this.strokeWidth;

        let format: AgRadarLineSeriesMarkerFormat | undefined = undefined;
        if (markerFormatter) {
            format = markerFormatter({
                datum,
                angleKey,
                radiusKey,
                fill,
                stroke,
                strokeWidth,
                size,
                highlighted: false,
                seriesId,
            });
        }

        const color = format?.fill ?? fill;

        const defaults: AgTooltipRendererResult = {
            title,
            backgroundColor: color,
            content,
        };

        if (tooltipFormat || tooltipRenderer) {
            const params = {
                datum,
                angleKey,
                angleValue,
                angleName,
                radiusKey,
                radiusValue,
                radiusName,
                title,
                color,
                seriesId,
            };
            if (tooltipFormat) {
                return toTooltipHtml(
                    {
                        content: interpolateString(tooltipFormat, params),
                    },
                    defaults
                );
            }
            if (tooltipRenderer) {
                return toTooltipHtml(tooltipRenderer(params), defaults);
            }
        }

        return toTooltipHtml(defaults);
    }

    getLegendData(): _ModuleSupport.ChartLegendDatum[] {
        const { id, data, angleKey, radiusKey, radiusName, visible, marker, stroke, strokeOpacity } = this;

        if (!(data?.length && angleKey && radiusKey)) {
            return [];
        }

        const legendData: _ModuleSupport.CategoryLegendDatum[] = [
            {
                legendType: 'category',
                id: id,
                itemId: radiusKey,
                seriesId: id,
                enabled: visible,
                label: {
                    text: radiusName ?? radiusKey,
                },
                marker: {
                    shape: marker.shape,
                    fill: marker.fill ?? marker.stroke ?? stroke ?? 'rgba(0, 0, 0, 0)',
                    stroke: marker.stroke ?? stroke ?? 'rgba(0, 0, 0, 0)',
                    fillOpacity: marker.fillOpacity ?? 1,
                    strokeOpacity: marker.strokeOpacity ?? strokeOpacity ?? 1,
                },
            },
        ];
        return legendData;
    }

    onLegendItemClick(event: _ModuleSupport.LegendItemClickChartEvent) {
        const { enabled, itemId, series } = event;

        if (series.id === this.id) {
            this.toggleSeriesItem(itemId, enabled);
        }
    }

    onLegendItemDoubleClick(event: _ModuleSupport.LegendItemDoubleClickChartEvent) {
        const { enabled, itemId, series, numVisibleItems } = event;

        if (series.id !== this.id) return;
        const totalVisibleItems = Object.values(numVisibleItems).reduce((p, v) => p + v, 0);

        const wasClicked = series.id === this.id;
        const newEnabled = wasClicked || (enabled && totalVisibleItems === 1);

        this.toggleSeriesItem(itemId, newEnabled);
    }

    protected pickNodeClosestDatum(point: _Scene.Point): _ModuleSupport.SeriesNodePickMatch | undefined {
        const { x, y } = point;
        const { radiusScale, rootGroup, nodeData, centerX: cx, centerY: cy, marker } = this;
        const hitPoint = rootGroup.transformPoint(x, y);
        const radius = radiusScale.range[1];

        const distanceFromCenter = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        if (distanceFromCenter > radius + marker.size) {
            return;
        }

        let minDistance = Infinity;
        let closestDatum: RadarLineNodeDatum | undefined;

        for (const datum of nodeData) {
            const { point: { x: datumX = NaN, y: datumY = NaN } = {} } = datum;
            if (isNaN(datumX) || isNaN(datumY)) {
                continue;
            }

            const distance = Math.sqrt((hitPoint.x - datumX) ** 2 + (hitPoint.y - datumY) ** 2);
            if (distance < minDistance) {
                minDistance = distance;
                closestDatum = datum;
            }
        }

        if (closestDatum) {
            const distance = Math.max(minDistance - (closestDatum.point?.size ?? 0), 0);
            return { datum: closestDatum, distance };
        }
    }

    animateEmptyUpdateReady() {}

    animateUpdateReady() {}
}
