"""Orquesta el aviso de NO DVIR: infractores + contacto + CC + correo.

Toma los grupos de un bloque diario (de `sheet_report.parse_blocks`) y el
`ContactBook` (de `contacts.parse_contacts`), y produce:
    - notices: avisos listos para enviar (con email del conductor y CC).
    - review:  conductores infractores sin contacto/region que hay que revisar.
"""

from dataclasses import dataclass, field

from .cc_routing import cc_for_region, region_from_truck
from .contacts import ContactBook
from .engine import MIN_DURATION_SECONDS
from .sheet_report import Group, offender_reasons


@dataclass
class Notice:
    driver: str
    company: str
    region: str | None
    email: str
    cc: list[str]
    reasons: list[dict]
    review_reason: str = ""  # no vacio => va a la lista de revisar
    units: list[str] = field(default_factory=list)


def _summarize_units(reasons: list[dict]) -> list[str]:
    """Texto por unidad infractora, p. ej. 'CF2254: NO DVIR' o
    'CF2250 (camión): 5m 31s'."""
    out = []
    for r in reasons:
        side = "camión" if r["kind"] == "truck" else "tráiler"
        if r["type"] == "NO_DVIR":
            out.append(f"{r['unit']}: NO DVIR")
        else:
            out.append(f"{r['unit']} ({side}): {r['detail']} (< 15 min)")
    return out


def build_notices(groups: list[Group], book: ContactBook,
                  threshold: int = MIN_DURATION_SECONDS
                  ) -> tuple[list[Notice], list[Notice]]:
    """Devuelve (notices, review) para un bloque diario."""
    notices: list[Notice] = []
    review: list[Notice] = []

    for g in groups:
        reasons = offender_reasons(g, threshold)
        if not reasons:
            continue
        # Unidad sin conductor en el reporte (p. ej. MDW-CF1846): no hay a
        # quien avisar y suelen ser unidades no asignadas/en desuso. Se omite.
        if not g.driver:
            continue

        contact = book.match(g.driver)
        unit = g.primary_unit()
        # Region: la del contacto (por su Truck#); si no, se deduce de la
        # unidad del propio bloque como respaldo.
        if contact and contact.region:
            region = contact.region
        else:
            region = region_from_truck(unit)
        # Contradiccion: un conductor de MCC cuya unidad no tiene prefijo de
        # terminal cae como "CHASER" en el respaldo. No se rutea mal: se manda
        # a revisar para que se cargue su terminal (Truck# con prefijo).
        if (contact and contact.company.upper() == "MCC"
                and region == "CHASER"):
            region = None
        cc = cc_for_region(region)

        notice = Notice(
            driver=g.driver or "(sin nombre)",
            company=g.company,
            region=region,
            email=contact.email if contact else "",
            cc=cc,
            reasons=reasons,
            units=_summarize_units(reasons),
        )

        # Acumula todos los problemas que impiden enviar (no solo el primero).
        problems: list[str] = []
        if contact is None:
            problems.append("no está en 'Driver info'")
        else:
            if not contact.email:
                problems.append("sin email en 'Driver info'")
            if not cc:
                problems.append(
                    f"terminal no reconocida (unidad {unit or '—'}; "
                    "cargar el prefijo regional, p. ej. ATL-CI2033)")

        if problems:
            notice.review_reason = "; ".join(problems)
            review.append(notice)
        else:
            notices.append(notice)

    return notices, review


# --- Composicion del correo --------------------------------------------------
DEFAULT_SUBJECT = "DVIR Compliance Notice — {date}"

# Plantilla oficial (texto provisto por Safety/Maintenance). Placeholders:
#   {driver}  nombre del conductor
#   {date}    fecha del bloque (legible, p. ej. "June 1")
#   {issues}  lista de unidades/issues detectados
DEFAULT_BODY = """Good Morning, {driver}

Please note, as per our conversation you did not complete a proper DVIR for the date of {date}.

The following was flagged on your assigned unit(s):
{issues}

We as a company stress the importance of DVIR's for several reasons.  The first of which, quite simply, is that it is a DOT REQUIREMENT.  This is not optional.  If pulled over, an officer can immediately place you out of service for not having a proper DVIR completed.  Further, all information entered into Samsara is available to all insurance providers.  When they see a driver habitually not doing the correct things that they are supposed to be doing, it results in a higher premium and could potentially lead to a driver being disqualified from working for us.  We do not wish for something so simple to become such a problem.

A proper DVIR should take a minimum of 15 mins.  This time should be logged as on duty time and the times on the log need to match what is entered on the DVIR.  The app provides a list of everything that needs to be checked and marked properly.  If something is unsafe, it needs to be corrected BEFORE the truck or trailer/chassis can be used.  You cannot log any miles until a DVIR is completed.  Please use the resources and tools available to you such as being able to upload pics into the app to confirm items were checked such as tires, lights, mud flaps, etc.  A proper 15 minute inspection sets you up for a successful day.  It reduces the chance of a breakdown or need for road service by an incredible 87%!!!!  This saves your time and the company's money.

When a driver receives a violation(s) on an inspection, this greatly affects the company's Safety scores.  The chain reaction leads, again, to higher insurance premiums, difficulty securing new customers/lanes of work, and, once a certain threshold is reached, EVERY TIME an officer sees one of our trucks they will pull you over which leads to more wasted time.   A driver can leave a company at any time, yet their violations will remain for 2 years.  We, as a company, need to protect our scores.  We cannot and will not allow driver's negligence to policy and procedure to jeopardize the company and the bottom line.

As a result of not turning in a DVIR, you will be fined $100 for this.  This will be deducted from your next settlement check.  Any further infraction of this policy will result in termination.  No exceptions.  As stated, we will not keep a driver on the fleet that is not doing what they are required to do.

If you have any questions, comments, thoughts, or issues with regards to Samsara, HOS, logs, or DVIR's, please reach out to Ryan Andrews at 773-765-8798.

Your time and cooperation in this matter is greatly appreciated......DRIVE SAFE!!!!!

Sincerely,
Adrian Ramirez
Safety/Maintenance Dept."""

_MONTHS = ["", "January", "February", "March", "April", "May", "June",
           "July", "August", "September", "October", "November", "December"]


def _format_date(label: str) -> str:
    """'6.1' -> 'June 1'. Si no se reconoce, devuelve la etiqueta tal cual."""
    parts = str(label).split(".")
    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
        month, day = int(parts[0]), int(parts[1])
        if 1 <= month <= 12:
            return f"{_MONTHS[month]} {day}"
    return str(label)


def _first_name(name: str) -> str:
    """'Cedric Dorsey' -> 'Cedric'; 'PATRICK WELLS' -> 'Patrick'."""
    tokens = str(name or "").strip().split()
    if not tokens:
        return "there"
    first = tokens[0]
    return first[:1].upper() + first[1:].lower()


def _issues_en(reasons: list[dict]) -> str:
    """Lista de issues en ingles para el cuerpo del correo."""
    out = []
    for r in reasons:
        if r["type"] == "NO_DVIR":
            out.append(f"  - {r['unit']}: no DVIR completed")
        else:
            side = "truck" if r["kind"] == "truck" else "trailer"
            out.append(f"  - {r['unit']} ({side}): DVIR only {r['detail']} "
                       "— under the 15 min minimum")
    return "\n".join(out)


def render_email(notice: Notice, date_label: str,
                 subject_tpl: str = DEFAULT_SUBJECT,
                 body_tpl: str = DEFAULT_BODY) -> tuple[str, str]:
    """Devuelve (asunto, cuerpo) para un aviso."""
    date = _format_date(date_label)
    ctx = {"driver": _first_name(notice.driver), "date": date,
           "issues": _issues_en(notice.reasons)}
    return subject_tpl.format(**ctx), body_tpl.format(**ctx)
