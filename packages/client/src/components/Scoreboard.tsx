import type { ScoreboardDTO } from '@murlan/shared';

interface ScoreboardProps {
  scoreboard: ScoreboardDTO;
  names: (seat: number) => string;
}

/** Cumulative scores + target, styled as a centred scorebar. 2v2 shows team
 *  totals; other modes show per-seat scores. */
export function Scoreboard({ scoreboard, names }: ScoreboardProps) {
  const { type, target, cumulative, teamTotals } = scoreboard;

  if (type === '2v2' && teamTotals) {
    return (
      <div className="flex justify-center items-center gap-3 flex-wrap">
        <div className="team-box">
          <span className="team-pip" style={{ background: 'var(--gold)' }} />
          <div>
            <div className="team-sc text-gold-hi">{teamTotals[0]}</div>
            <small className="text-muted text-xs">Skuadra 1</small>
          </div>
        </div>
        <div className="text-muted text-xs tracking-wide">— deri në <b className="text-gold-hi">{target}</b> —</div>
        <div className="team-box">
          <span className="team-pip" style={{ background: '#5fb0e8' }} />
          <div>
            <div className="team-sc" style={{ color: '#9bd0f5' }}>{teamTotals[1]}</div>
            <small className="text-muted text-xs">Skuadra 2</small>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel px-4 py-2.5 flex items-center gap-4 flex-wrap justify-center">
      <span className="font-display text-xs tracking-wide text-gold-hi">REZULTATI</span>
      {cumulative.map((pts, seat) => (
        <span key={seat} className="text-sm text-txt">
          <span className="text-muted">{names(seat)}:</span> <b className="text-gold-hi">{pts}</b>
        </span>
      ))}
      <span className="text-muted text-xs">deri në <b className="text-gold-hi">{target}</b></span>
    </div>
  );
}
