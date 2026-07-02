// Home cinematico de Rigsmith (F6). Orden segun el playbook competitivo
// (docs/competitive cap 07): hero con la app real en escena -> prueba social
// como panel de instrumentos -> el moat (plataforma agnostica) -> producto por
// tabs -> el loop narrado -> comparacion honesta -> cierre de marca.
import Hero from '../home/Hero'
import InstrumentBand from '../home/InstrumentBand'
import PlatformDiagram from '../home/PlatformDiagram'
import ProductTabs from '../home/ProductTabs'
import FlowStory from '../home/FlowStory'
import Compare from '../home/Compare'
import FinalCta from '../home/FinalCta'

export default function Home() {
  return (
    <>
      <Hero />
      <InstrumentBand />
      <PlatformDiagram />
      <ProductTabs />
      <FlowStory />
      <Compare />
      <FinalCta />
    </>
  )
}
