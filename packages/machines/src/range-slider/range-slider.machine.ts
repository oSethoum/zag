import { createMachine, preserve } from "@ui-machines/core"
import {
  addDomEvent,
  dispatchInputEvent,
  EventListenerWithPointInfo as Listener,
  isMouseEvent,
} from "@ui-machines/utils/dom-event"
import { nextTick, pipe } from "@ui-machines/utils/function"
import { Rect } from "@ui-machines/utils/rect"
import { Point } from "@ui-machines/utils/point"
import { Range } from "@ui-machines/utils/range"
import { WithDOM } from "../type-utils"
import { getElements, getRangeAtIndex, pointToValue } from "./range-slider.dom"

export type RangeSliderMachineContext = WithDOM<{
  name?: string
  threshold: number
  activeIndex: number
  value: number[]
  disabled?: boolean
  orientation?: "vertical" | "horizontal"
  onChange?(value: number[]): void
  onChangeStart?(value: number[]): void
  onChangeEnd?(value: number[]): void
  getAriaValueText?(value: number, index: number): string
  min: number
  max: number
  step: number
}>

export type RangeSliderMachineState = {
  value: "idle" | "panning" | "focus"
}

export const rangeSliderMachine = createMachine<
  RangeSliderMachineContext,
  RangeSliderMachineState
>(
  {
    id: "range-slider-machine",
    initial: "idle",
    context: {
      uid: "48",
      threshold: 5,
      activeIndex: -1,
      min: 0,
      max: 100,
      step: 1,
      value: [0, 100],
      orientation: "horizontal",
      direction: "ltr",
    },
    on: {
      MOUNT: {
        actions: ["setId", "setOwnerDocument"],
      },
    },
    states: {
      idle: {
        on: {
          POINTER_DOWN: {
            target: "panning",
            actions: [
              "setActiveIndex",
              "setValueForEvent",
              "invokeOnChangeStart",
              "invokeOnChange",
              "focusActiveThumb",
            ],
          },
          FOCUS: {
            target: "focus",
            actions: ["setActiveIndex", "focusActiveThumb"],
          },
        },
      },
      focus: {
        entry: "focusActiveThumb",
        on: {
          POINTER_DOWN: {
            target: "panning",
            actions: [
              "setActiveIndex",
              "setValueForEvent",
              "invokeOnChangeStart",
              "invokeOnChange",
              "focusActiveThumb",
            ],
          },
          ARROW_LEFT: {
            actions: ["decrementAtIndex", "invokeOnChange"],
          },
          ARROW_RIGHT: {
            actions: ["incrementAtIndex", "invokeOnChange"],
          },
          ARROW_UP: {
            actions: ["incrementAtIndex", "invokeOnChange"],
          },
          ARROW_DOWN: {
            actions: ["decrementAtIndex", "invokeOnChange"],
          },
          PAGE_UP: {
            actions: ["incrementAtIndex", "invokeOnChange"],
          },
          PAGE_DOWN: {
            actions: ["decrementAtIndex", "invokeOnChange"],
          },
          HOME: {
            actions: ["setActiveThumbToMin", "invokeOnChange"],
          },
          END: {
            actions: ["setActiveThumbToMax", "invokeOnChange"],
          },
          BLUR: "idle",
        },
      },
      panning: {
        entry: "focusActiveThumb",
        activities: "attachPointerTrackers",
        on: {
          POINTER_UP: { target: "focus", actions: "invokeOnChangeEnd" },
        },
      },
    },
  },
  {
    activities: {
      attachPointerTrackers(ctx, _evt, { send }) {
        const doc = ctx.doc ?? document

        const onPointerMove: Listener = (event, info) => {
          if (info.point.distance() < ctx.threshold) {
            return
          }

          // Because Safari doesn't trigger mouseup events when it's above a `<select>`
          if (isMouseEvent(event) && event.button === 0) {
            send("POINTER_UP")
            return
          }

          const value = pointToValue(ctx, info.point)
          if (typeof value === "undefined") return

          ctx.value[ctx.activeIndex] = value
          ctx.onChange?.(ctx.value)
          dispatchChangeEvent(ctx)
        }

        const onPointerUp = () => {
          send("POINTER_UP")
        }

        return pipe(
          addDomEvent(doc, "pointermove", onPointerMove, false),
          addDomEvent(doc, "pointerup", onPointerUp, false),
          addDomEvent(doc, "pointercancel", onPointerUp, false),
          addDomEvent(doc, "contextmenu", onPointerUp, false),
        )
      },
    },
    actions: {
      setId(ctx, evt) {
        ctx.uid = evt.id
      },
      setOwnerDocument(ctx, evt) {
        ctx.doc = preserve(evt.doc)
      },
      invokeOnChangeStart(ctx) {
        ctx.onChangeStart?.(ctx.value)
      },
      invokeOnChangeEnd(ctx) {
        ctx.onChangeEnd?.(ctx.value)
      },
      invokeOnChange(ctx) {
        ctx.onChange?.(ctx.value)
        dispatchChangeEvent(ctx)
      },
      setActiveIndex(ctx, evt) {
        // evt.index means this was passed on a keyboard event (`onKeyDown`)
        let index = evt.index

        // if there's no index, we assume it's from a pointer down event (`onPointerDown`)
        // and we attempt to compute the closest index
        if (index == null) {
          const { thumbs } = getElements(ctx)

          // get the center point of all thumbs
          const points = thumbs
            .map((el) => Rect.fromElement(el))
            .map((rect) => rect.centerPoint)

          // get the closest center point from the event ("pointerdown") point
          const getClosest = Point.closest(...points)
          index = getClosest(evt.point)
        }

        ctx.activeIndex = index
      },
      setValueForEvent(ctx, evt) {
        const value = pointToValue(ctx, evt.point)
        if (typeof value === "number") {
          ctx.value[ctx.activeIndex] = value
        }
      },
      focusActiveThumb(ctx) {
        nextTick(() => {
          const { getThumb } = getElements(ctx)
          const thumb = getThumb(ctx.activeIndex)
          thumb?.focus()
        })
      },
      decrementAtIndex(ctx, evt) {
        const range = getRangeAtIndex(ctx).decrement(evt.step)
        ctx.value[ctx.activeIndex] = range
          .clone()
          .snapToStep(range)
          .clamp()
          .valueOf()
      },
      incrementAtIndex(ctx, evt) {
        const range = getRangeAtIndex(ctx).increment(evt.step)
        ctx.value[ctx.activeIndex] = range
          .clone()
          .snapToStep(range)
          .clamp()
          .valueOf()
      },
      setActiveThumbToMin(ctx) {
        const range = getRangeAtIndex(ctx)
        ctx.value[ctx.activeIndex] = range.clone().setToMin().valueOf()
      },
      setActiveThumbToMax(ctx) {
        const options = getRangeAtIndex(ctx)
        ctx.value[ctx.activeIndex] = new Range(options).setToMax().valueOf()
      },
    },
  },
)

// dispatch change/input event to closest `form` element
function dispatchChangeEvent(ctx: RangeSliderMachineContext) {
  const value = ctx.value[ctx.activeIndex]
  const { getInput } = getElements(ctx)
  const input = getInput(ctx.activeIndex)
  if (!input) return
  dispatchInputEvent(input, value)
}