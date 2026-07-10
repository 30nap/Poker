import { Card, RANK_CHARS, rankOf, suitOf, UNKNOWN_CARD } from '@poker/engine';

const SUIT_GLYPHS = ['♣', '♦', '♥', '♠'];

export function CardView({
  card,
  small,
  delay,
}: {
  /** UNKNOWN_CARD (or undefined) renders a face-down card. */
  card?: Card;
  small?: boolean;
  /** Stagger for the deal-in animation, in ms. */
  delay?: number;
}) {
  const cls = small ? 'card small' : 'card';
  const style = delay ? { animationDelay: `${delay}ms` } : undefined;

  if (card === undefined || card === UNKNOWN_CARD) {
    return <div className={`${cls} back`} style={style} />;
  }
  const suit = suitOf(card);
  const rank = RANK_CHARS[rankOf(card)]!;
  return (
    <div className={`${cls} face ${suit === 1 || suit === 2 ? 'red' : 'black'}`} style={style}>
      <span className="card-rank">{rank === 'T' ? '10' : rank}</span>
      <span className="card-suit">{SUIT_GLYPHS[suit]}</span>
    </div>
  );
}
