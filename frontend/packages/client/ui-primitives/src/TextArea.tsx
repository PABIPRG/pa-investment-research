import { forwardRef } from 'react'
import type { TextareaHTMLAttributes } from 'react'
import clsx from 'clsx'
import css from './TextArea.module.css'

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={clsx(css.textarea, className)} {...props} />
})
