from __future__ import annotations

import os
from pathlib import Path
import shutil
from typing import Protocol

from ..workspace import resolve_workspace_path
from .common import RecipeError, sha256


class DriveProvider(Protocol):
    def upload(self, path: Path, *, name: str, parent_id: str | None) -> dict: ...


class GoogleDriveProvider:
    """Supply an already authorized client, or use Application Default Credentials."""
    def __init__(self, client=None):
        if client is None:
            import google.auth
            from google.auth.exceptions import DefaultCredentialsError
            from googleapiclient.discovery import build
            try:
                credentials, _ = google.auth.default(scopes=['https://www.googleapis.com/auth/drive.file'])
            except DefaultCredentialsError as error:
                raise RecipeError('DRIVE_AUTH_MISSING', 'authorized Drive client or ADC is required') from error
            client = build('drive', 'v3', credentials=credentials, cache_discovery=False)
        self.client = client

    def upload(self, path: Path, *, name: str, parent_id: str | None) -> dict:
        from googleapiclient.http import MediaFileUpload
        body = {'name': name}
        if parent_id:
            body['parents'] = [parent_id]
        request = self.client.files().create(body=body, media_body=MediaFileUpload(str(path), resumable=True), fields='id,name,size,md5Checksum,webViewLink')
        response = None
        while response is None:
            _, response = request.next_chunk()
        return response


def export_drive(spec: dict, workspace: Path, *, provider: DriveProvider | None = None) -> dict:
    source = resolve_workspace_path(workspace, spec['source_path'])
    if not source.is_file() or source.is_symlink():
        raise ValueError('Drive source must be a regular workspace file')
    mode = spec.get('mode', 'mount')
    if mode == 'mount':
        configured = os.environ.get('COLAB_BRIDGE_DRIVE_MOUNT')
        if not configured or not Path(configured).is_dir():
            raise RecipeError('DRIVE_MOUNT_MISSING', 'configure an existing COLAB_BRIDGE_DRIVE_MOUNT')
        destination = resolve_workspace_path(Path(configured), spec['destination'], create_parent=True)
        if destination.exists():
            raise RecipeError('OUTPUT_EXISTS', 'Drive destination already exists')
        with source.open('rb') as incoming, destination.open('xb') as outgoing:
            shutil.copyfileobj(incoming, outgoing)
        result = {'destination': str(destination)}
    elif mode == 'api':
        provider = provider or GoogleDriveProvider()
        result = provider.upload(source, name=spec.get('name', source.name), parent_id=spec.get('parent_id'))
    else:
        raise ValueError('Drive mode must be mount or api')
    return {'mode': mode, 'source_path': spec['source_path'], 'sha256': sha256(source), 'drive': result, **({'destination': result['destination']} if mode == 'mount' else {})}
