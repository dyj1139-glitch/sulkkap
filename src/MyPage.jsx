import { useEffect, useMemo, useRef, useState } from 'react';
import { call, db, finishLogin, shareUrl } from './social.js';
import './social-ui.css';

export default function MyPage({
  user,
  onOpen,
  onStart,
  onLogout,
  busy,
  error,
  formatTime
}) {
  const heading = useRef(null);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  const [data, setData] = useState(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);

  const [tab, setTab] = useState('receipts');
  const [query, setQuery] = useState('');

  // 기본값: 최신 날짜순
  const [sort, setSort] = useState('latest');

  const [favorites, setFavorites] = useState(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(`sulkkap:favorites:${user.id}`) || '[]'
      );
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    let alive = true;

    setLoading(true);
    setNotice('');

    (async () => {
      let warning = '';

      try {
        await finishLogin();
      } catch {
        warning =
          '일부 새 기록을 아직 보관하지 못했어요. 잠시 후 새로고침해주세요.';
      }

      try {
        const history = await call('sk_history');
        const rooms = history?.rooms || [];

        let missions = [];

        if (rooms.length) {
          const result = await db
            .from('sk_missions')
            .select('id,room,done,minutes')
            .in(
              'room',
              rooms.map(r => r.id)
            )
            .abortSignal(AbortSignal.timeout(15000));

          if (result.error) {
            missions = null;
            warning =
              '미션 진행률을 불러오지 못했어요. 약속을 열어 확인해주세요.';
          } else {
            missions = result.data;
          }
        }

        if (alive) {
          setData({
            receipts: history?.receipts || [],
            rooms,
            missions
          });

          setNotice(warning);
        }
      } catch (e) {
        if (alive) setNotice(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [user.id, retry]);

  const toggleFavorite = id => {
    const next = favorites.includes(id)
      ? favorites.filter(x => x !== id)
      : [...favorites, id];

    setFavorites(next);

    try {
      localStorage.setItem(
        `sulkkap:favorites:${user.id}`,
        JSON.stringify(next)
      );
    } catch {
      setNotice(
        '즐겨찾기를 저장하지 못했어요. 이 화면에서만 유지돼요.'
      );
    }
  };

  /*
   * ─────────────────────────────
   * 누적 술깝 통계
   * ─────────────────────────────
   */

  const totalChargedMinutes = useMemo(() => {
    if (!data?.receipts) return 0;

    return data.receipts.reduce((total, item) => {
      const minutes = Number(item?.record?.minutes);

      return total + (Number.isFinite(minutes) ? minutes : 0);
    }, 0);
  }, [data]);

  const totalRecoveredMinutes = useMemo(() => {
    if (!Array.isArray(data?.missions)) return 0;

    return data.missions.reduce((total, mission) => {
      if (!mission.done) return total;

      const minutes = Number(mission.minutes);

      return total + (Number.isFinite(minutes) ? minutes : 0);
    }, 0);
  }, [data]);

  const currentLifeMinutes = Math.max(
    0,
    totalChargedMinutes - totalRecoveredMinutes
  );

  const completedMissionCount = Array.isArray(data?.missions)
    ? data.missions.filter(m => m.done).length
    : null;

  /*
   * ─────────────────────────────
   * 영수증 검색 + 정렬
   * ─────────────────────────────
   */

  const receipts = useMemo(() => {
    let list = (data?.receipts || []).filter(x => {
      const r = x.record;

      if (tab === 'favorites' && !favorites.includes(r.id)) {
        return false;
      }

      const searchable =
        `${r.occasion || ''} ${r.date || ''}`.toLowerCase();

      return searchable.includes(query.toLowerCase());
    });

    list = [...list];

    if (sort === 'charged') {
      // 청구 시간이 큰 영수증부터
      list.sort(
        (a, b) =>
          Number(b.record?.minutes || 0) -
          Number(a.record?.minutes || 0)
      );
    } else {
      // 날짜 최신순
      list.sort((a, b) => {
        const dateA = a.record?.date || '';
        const dateB = b.record?.date || '';

        return dateB.localeCompare(dateA);
      });
    }

    return list;
  }, [data, tab, favorites, query, sort]);

  const rooms = (data?.rooms || []).filter(x =>
    `${x.occasion || ''} ${x.message || ''}`
      .toLowerCase()
      .includes(query.toLowerCase())
  );

  const name =
    user.user_metadata?.full_name ||
    user.email?.split('@')[0] ||
    '술깝 회원';

  return (
    <main className="sk-stage my-page">
      <p className="eyebrow">MY SULKKAP · 나의 기록</p>

      <h1 ref={heading} tabIndex={-1}>
        마이페이지
      </h1>

      {/* ───── 계정 + 누적 술깝 ───── */}

      <section className="account-pass">
        <div className="pass-top">
          <span className="pass-avatar" aria-hidden="true">
            {name.slice(0, 1)}
          </span>

          <div>
            <strong>{name}님의 술깝</strong>
            <p>{user.email || '연결된 계정으로 보관 중'}</p>
          </div>

          <span className="pass-stamp">MEMBER</span>
        </div>

        <p className="pass-copy">
          지금까지 쌓인
          <br />
          나의 술깝 기록.
        </p>

        <div className="life-summary">
          <div className="life-summary-main">
            <span>현재 술깝</span>

            <strong>
              {data ? `−${formatTime(currentLifeMinutes)}` : '—'}
            </strong>

            <small>
              지금까지 청구된 시간에서
              <br />
              회복한 시간을 뺀 값
            </small>
          </div>

          <div className="life-summary-detail">
            <div>
              <span>총 청구 수명</span>
              <strong>
                {data ? `−${formatTime(totalChargedMinutes)}` : '—'}
              </strong>
            </div>

            <div>
              <span>총 회복 수명</span>
              <strong className="recovered-time">
                {data?.missions
                  ? `+${formatTime(totalRecoveredMinutes)}`
                  : '—'}
              </strong>
            </div>
          </div>
        </div>

        <div className="my-stats">
          <div>
            <strong>{data ? data.receipts.length : '—'}</strong>
            <span>영수증</span>
          </div>

          <div>
            <strong>{data ? data.rooms.length : '—'}</strong>
            <span>함께한 공유</span>
          </div>

          <div>
            <strong>
              {completedMissionCount === null
                ? '—'
                : completedMissionCount}
            </strong>
            <span>완료 미션</span>
          </div>
        </div>
      </section>

      <button className="primary my-new" onClick={onStart}>
        새 영수증 만들기
        <span aria-hidden="true">＋</span>
      </button>

      {/* ───── 컬렉션 ───── */}

      <div className="library-head">
        <h2>나의 컬렉션</h2>

        <button
          className="link-button"
          disabled={loading}
          onClick={() => setRetry(n => n + 1)}
        >
          {loading ? '불러오는 중…' : '새로고침 ↻'}
        </button>
      </div>

      <div
        className="library-tabs"
        role="group"
        aria-label="기록 종류"
      >
        {[
          ['receipts', '영수증'],
          ['rooms', '함께한 약속'],
          ['favorites', '즐겨찾기']
        ].map(([id, title]) => (
          <button
            key={id}
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {title}
          </button>
        ))}
      </div>

      <label className="library-search">
        <span className="sr-only">기록 검색</span>

        <input
          type="search"
          placeholder={
            tab === 'rooms'
              ? '약속 이름으로 찾아보기'
              : '술자리 이름이나 날짜로 찾아보기'
          }
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
      </label>

      {/* 영수증 / 즐겨찾기에서만 정렬 표시 */}

      {tab !== 'rooms' && (
        <div
          className="receipt-sort"
          role="group"
          aria-label="영수증 정렬"
        >
          <span>정렬</span>

          <div>
            <button
              type="button"
              aria-pressed={sort === 'latest'}
              onClick={() => setSort('latest')}
            >
              최신순
            </button>

            <button
              type="button"
              aria-pressed={sort === 'charged'}
              onClick={() => setSort('charged')}
            >
              청구 시간순
            </button>
          </div>
        </div>
      )}

      {(notice || error) && (
        <p className="error" role="alert">
          {error || notice}
        </p>
      )}

      {loading && !data && (
        <div className="library-empty" role="status">
          소중한 기록을 꺼내고 있어요…
        </div>
      )}

      {!loading && !data && (
        <div className="library-empty">
          <h3>보관함에 연결하지 못했어요</h3>
          <p>기록을 확인하려면 다시 시도해주세요.</p>

          <button
            className="secondary"
            onClick={() => setRetry(n => n + 1)}
          >
            다시 불러오기
          </button>
        </div>
      )}

      {/* ───── 영수증 ───── */}

      {data && tab !== 'rooms' && (
        <div className="receipt-collection">
          {receipts.map(({ record: r }) => (
            <article className="collection-ticket" key={r.id}>
              <div className="ticket-meta">
                <span>{r.date}</span>

                <button
                  className="favorite-button"
                  aria-label={`${r.occasion} 즐겨찾기`}
                  aria-pressed={favorites.includes(r.id)}
                  onClick={() => toggleFavorite(r.id)}
                >
                  {favorites.includes(r.id) ? '★' : '☆'}
                </button>
              </div>

              <button
                className="ticket-open"
                onClick={() => onOpen(r)}
              >
                <h3>{r.occasion}</h3>

                <div className="ticket-info">
                  <span>{r.people}명</span>
                  <span aria-hidden="true">·</span>
                  <span>{r.items.length}개 품목</span>
                </div>

                <div className="ticket-total">
                  <span>청구 수명</span>

                  <strong>
                    −{formatTime(r.minutes)}
                  </strong>
                </div>

                <span className="ticket-bottom">
                  <span>영수증 펼쳐보기</span>
                  <span aria-hidden="true">↗</span>
                </span>
              </button>
            </article>
          ))}
        </div>
      )}

      {/* ───── 함께한 약속 ───── */}

      {data && tab === 'rooms' && (
        <div className="room-collection">
          {rooms.map(r => {
            const missions = (data.missions || []).filter(
              m => m.room === r.id
            );

            const done = missions.filter(m => m.done).length;

            return (
              <a
                className="room-card"
                href={shareUrl(r.id)}
                key={r.id}
              >
                <span className="room-tag">
                  {r.purpose === 'mission'
                    ? '함께할 약속'
                    : '공유한 영수증'}
                </span>

                <h3>
                  {r.occasion || '우리의 술자리'}
                  <span aria-hidden="true">↗</span>
                </h3>

                {r.message && <p>{r.message}</p>}

                <div className="room-progress">
                  <span
                    style={{
                      width: `${
                        missions.length
                          ? (done / missions.length) * 100
                          : 0
                      }%`
                    }}
                  />
                </div>

                <small>
                  {data.missions === null
                    ? '진행률을 확인하지 못했어요'
                    : missions.length
                    ? `${done} / ${missions.length}개 미션 완료`
                    : '열어서 함께할 약속을 추가해요'}
                </small>
              </a>
            );
          })}
        </div>
      )}

      {/* ───── 빈 컬렉션 ───── */}

      {data &&
        (tab === 'rooms' ? !rooms.length : !receipts.length) && (
          <div className="library-empty">
            <span aria-hidden="true">✳</span>

            <h3>
              {query
                ? '찾는 기록이 없어요'
                : tab === 'favorites'
                ? '다시 보고 싶은 순간을 모아요'
                : tab === 'rooms'
                ? '다음 약속을 만들어볼까요?'
                : '첫 영수증을 기다리고 있어요'}
            </h3>

            <p>
              {query
                ? '다른 이름이나 날짜로 검색해보세요.'
                : tab === 'favorites'
                ? '영수증의 별을 누르면 여기에 모여요.'
                : tab === 'rooms'
                ? '영수증에서 미션을 골라 친구에게 보내보세요.'
                : '술자리의 이름과 마신 양을 적어보세요.'}
            </p>
          </div>
        )}

      <p className="collection-note">
        청구·복원 시간은 재미를 위한 게임 수치예요.
        <br />
        즐겨찾기는 이 브라우저에 저장돼요.
      </p>

      <div className="account-footer">
        <span>이 계정의 기록만 표시해요</span>

        <button
          className="link-button"
          disabled={busy}
          onClick={onLogout}
        >
          {busy ? '처리 중…' : '로그아웃'}
        </button>
      </div>
    </main>
  );
}