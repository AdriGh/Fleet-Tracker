import { motion, useReducedMotion, type HTMLMotionProps } from 'motion/react'

// Aparicion al entrar en viewport (MOTION 5). Honra prefers-reduced-motion:
// si el usuario lo pide, no anima (queda estatico).
export default function Reveal({
  delay = 0,
  y = 22,
  children,
  ...rest
}: HTMLMotionProps<'div'> & { delay?: number; y?: number }) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.6, delay, ease: [0.16, 1, 0.3, 1] }}
      {...rest}
    >
      {children}
    </motion.div>
  )
}
