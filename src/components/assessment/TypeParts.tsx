/**
 * A question type's input / view as a component of its own, so the hooks inside a type's UI never mix with the page's hooks
 * (the student's task pages and the marking desk show different types as the person moves on).
 */
import { typeUi, type InputProps, type ViewProps } from "./registry";

export function TypeInput(props: InputProps) { return <>{typeUi(props.q.type).Input(props)}</>; }
export function TypeView(props: ViewProps) { return <>{typeUi(props.q.type).View(props)}</>; }
