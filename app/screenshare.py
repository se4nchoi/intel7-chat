"""In-memory state and session manager for multi-channel & DM LAN Screen Sharing."""
from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import datetime, timezone
import logging
import uuid
from typing import Any, Dict, List, Optional, Set, Union

logger = logging.getLogger(__name__)


def normalize_room_id(raw_id: Any) -> Union[int, str]:
    """Normalize a channel/DM room identifier.

    - If int or numeric string: returns int (e.g. 1, 2)
    - If DM room key (e.g. "dm:alice:bob"): returns lowercase string
    - Defaults to 1 if None
    """
    if raw_id is None:
        return 1
    if isinstance(raw_id, int):
        return raw_id
    s = str(raw_id).strip()
    if s.startswith("dm:"):
        return s.lower()
    try:
        return int(s)
    except (ValueError, TypeError):
        return s


class ScreenShareManager:
    """Manages concurrent screen share sessions across multiple channels and DMs."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        # room_id (int or str) -> session dict
        self.sessions: Dict[Union[int, str], Dict[str, Any]] = {}
        # room_id -> set of viewer user_ids
        self.viewers: Dict[Union[int, str], Set[int]] = defaultdict(set)
        self.viewer_clients: Dict[Union[int, str], Dict[str, int]] = defaultdict(dict)

    async def start_session(
        self,
        user_id: int,
        username: str,
        display_name: str,
        channel_id: Union[int, str],
        title: str = "",
        client_id: str | None = None,
    ) -> Dict[str, Any]:
        """Start a screen share session in channel_id (channel int or DM str).

        If the presenter already has an active session in another room, that
        previous session is automatically stopped first.
        """
        room_id = normalize_room_id(channel_id)
        async with self._lock:
            current = self.sessions.get(room_id)
            if current and (current["user_id"] != user_id or
                            current.get("presenter_client_id") != client_id):
                raise ValueError("이 채널에서 이미 화면 공유 중입니다.")
            if current:
                return dict(current)
            stopped_sessions = []
            # 1. If presenter is already streaming in another room, clean it up
            old_rooms = [
                rid for rid, s in self.sessions.items()
                if s["user_id"] == user_id and rid != room_id
            ]
            for old_rid in old_rooms:
                stopped_sessions.append(self.sessions.pop(old_rid))
                self.viewers.pop(old_rid, None)
                self.viewer_clients.pop(old_rid, None)
                logger.info("Presenter %s switched stream away from room %s", username, old_rid)

            # 2. Register new session
            now = datetime.now(timezone.utc).isoformat()
            is_dm = isinstance(room_id, str) and room_id.startswith("dm:")
            session = {
                "channel_id": room_id,
                "room_type": "dm" if is_dm else "channel",
                "user_id": user_id,
                "username": username,
                "display_name": display_name or username,
                "title": title or f"{display_name or username}님의 화면",
                "started_at": now,
                "session_id": uuid.uuid4().hex,
                "presenter_client_id": client_id,
            }
            self.sessions[room_id] = session
            self.viewers[room_id] = {user_id}
            self.viewer_clients[room_id] = {}
            logger.info("Screen share started in room %s by user %s (%s)", room_id, username, user_id)
            return {**session, "stopped_sessions": stopped_sessions}

    async def stop_session(
        self,
        channel_id: Optional[Union[int, str]] = None,
        user_id: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Stop one or more screen share sessions.

        - If channel_id is specified: stops stream in that room (if user_id matches or is None).
        - If channel_id is None and user_id is specified: stops all sessions hosted by user_id.
        """
        room_id = normalize_room_id(channel_id) if channel_id is not None else None
        stopped_sessions: List[Dict[str, Any]] = []
        async with self._lock:
            if room_id is not None:
                session = self.sessions.get(room_id)
                if session and (user_id is None or session["user_id"] == user_id):
                    stopped = self.sessions.pop(room_id)
                    self.viewers.pop(room_id, None)
                    self.viewer_clients.pop(room_id, None)
                    stopped_sessions.append(stopped)
                    logger.info("Screen share stopped in room %s by user %s", room_id, user_id)
            elif user_id is not None:
                matching_rids = [
                    rid for rid, s in self.sessions.items()
                    if s["user_id"] == user_id
                ]
                for rid in matching_rids:
                    stopped = self.sessions.pop(rid)
                    self.viewers.pop(rid, None)
                    self.viewer_clients.pop(rid, None)
                    stopped_sessions.append(stopped)
                    logger.info("Screen share stopped in room %s for user %s", rid, user_id)

        return stopped_sessions

    async def get_channel_status(self, channel_id: Union[int, str]) -> Dict[str, Any]:
        """Return status for a single room."""
        room_id = normalize_room_id(channel_id)
        async with self._lock:
            session = self.sessions.get(room_id)
            if not session:
                return {"is_active": False, "channel_id": room_id, "session": None, "viewer_count": 0}
            return {
                "is_active": True,
                "channel_id": room_id,
                "session": dict(session),
                "viewer_count": len(self.viewers.get(room_id, set())),
            }

    async def get_all_sessions(self, for_username: Optional[str] = None) -> Dict[str, Dict[str, Any]]:
        """Return a mapping of all active sessions keyed by str(room_id).

        If for_username is provided, DM sessions not involving for_username
        are omitted for privacy.
        """
        async with self._lock:
            res: Dict[str, Dict[str, Any]] = {}
            for rid, session in self.sessions.items():
                rid_str = str(rid)
                if rid_str.startswith("dm:") and for_username is not None:
                    parts = rid_str.split(":")
                    if len(parts) >= 3 and for_username.lower() not in (parts[1].lower(), parts[2].lower()):
                        continue
                res[rid_str] = {
                    **session,
                    "viewer_count": len(self.viewers.get(rid, set())),
                }
            return res

    async def add_viewer(self, channel_id: Union[int, str], user_id: int,
                         client_id: str | None = None) -> int:
        """Add a viewer to a room session and return updated viewer count."""
        room_id = normalize_room_id(channel_id)
        async with self._lock:
            if room_id in self.sessions:
                self.viewers[room_id].add(user_id)
                if client_id:
                    self.viewer_clients[room_id][client_id] = user_id
            return len(self.viewers.get(room_id, set()))

    async def remove_viewer(self, channel_id: Union[int, str], user_id: int,
                            client_id: str | None = None) -> int:
        """Remove a viewer from a room session and return updated viewer count."""
        room_id = normalize_room_id(channel_id)
        async with self._lock:
            if room_id in self.viewers:
                clients = self.viewer_clients[room_id]
                if client_id:
                    clients.pop(client_id, None)
                else:
                    for key, uid in list(clients.items()):
                        if uid == user_id:
                            clients.pop(key)
                session = self.sessions.get(room_id)
                if user_id not in clients.values() and (not session or session["user_id"] != user_id):
                    self.viewers[room_id].discard(user_id)
            return len(self.viewers.get(room_id, set()))

    def is_viewer(self, channel_id: Union[int, str], user_id: int,
                  client_id: str | None = None) -> bool:
        room_id = normalize_room_id(channel_id)
        if client_id:
            return self.viewer_clients.get(room_id, {}).get(client_id) == user_id
        return user_id in self.viewers.get(room_id, set())

    async def remove_viewer_from_all(self, user_id: int) -> Dict[Union[int, str], int]:
        """Remove a viewer from all rooms they might be watching.

        Returns {room_id: new_viewer_count} for any affected rooms.
        """
        affected: Dict[Union[int, str], int] = {}
        async with self._lock:
            for rid, viewer_set in list(self.viewers.items()):
                if user_id in viewer_set:
                    viewer_set.discard(user_id)
                    for key, uid in list(self.viewer_clients.get(rid, {}).items()):
                        if uid == user_id:
                            self.viewer_clients[rid].pop(key)
                    affected[rid] = len(viewer_set)
        return affected

    def is_presenter(self, user_id: int, channel_id: Optional[Union[int, str]] = None) -> bool:
        """Check if user_id is actively presenting."""
        if channel_id is not None:
            room_id = normalize_room_id(channel_id)
            s = self.sessions.get(room_id)
            return bool(s and s.get("user_id") == user_id)
        return any(s.get("user_id") == user_id for s in self.sessions.values())

    def get_presenter_channel(self, user_id: int) -> Optional[Union[int, str]]:
        """Return the room_id where user_id is presenting, if any."""
        for rid, s in self.sessions.items():
            if s.get("user_id") == user_id:
                return rid
        return None


# Global singleton instance
screenshare_manager = ScreenShareManager()

