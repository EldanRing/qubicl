import type { Stats } from 'node:fs';
import { QubiclError } from './errors.js';

export type FileOperation = 'list' | 'inspect' | 'read' | 'write' | 'edit' | 'copy' | 'move' | 'delete';

export interface FileErrorContext {
  operation: FileOperation;
  path?: string;
  source?: string;
  destination?: string;
}

export function creationTime(info: Pick<Stats, 'birthtimeMs'>): string | null {
  return Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0
    ? new Date(info.birthtimeMs).toISOString()
    : null;
}

export function mapFileSystemError(error: unknown, context: FileErrorContext): unknown {
  if (error instanceof QubiclError) return error;
  const code = errnoCode(error);
  const reportedPath = errnoPath(error);
  const path = inputPath(context, reportedPath);

  if (code === 'ENOENT') {
    return new QubiclError('path_not_found', `Path ${path} was not found. Check the path and retry.`, 404);
  }
  if (code === 'ERR_FS_CP_EEXIST' || code === 'EEXIST') {
    const destination = context.destination ?? path;
    return new QubiclError('destination_exists', `Destination ${destination} already exists. Choose another destination or retry with overwrite enabled.`, 409);
  }
  if (code === 'ERR_FS_CP_DIR_TO_NON_DIR' || code === 'ERR_FS_CP_NON_DIR_TO_DIR' || code === 'ERR_FS_CP_EINVAL') {
    const destination = context.destination ?? path;
    return new QubiclError('destination_invalid', `Destination ${destination} is not compatible with the source. Choose a destination with the same path type that is not inside the source.`, 400);
  }
  if (code === 'ERR_FS_EISDIR') {
    if (context.operation === 'delete') {
      return new QubiclError('recursive_required', `Path ${context.path ?? path} is a directory. Retry with recursive deletion enabled.`, 400);
    }
    if (context.destination) {
      return new QubiclError('destination_invalid', `Destination ${context.destination} is a directory where a file is required. Choose another destination.`, 400);
    }
    return new QubiclError('not_a_file', `Path ${context.path ?? path} is not a regular file.`, 400);
  }
  if (code === 'ENOTDIR') {
    if (context.operation === 'list') {
      return new QubiclError('not_a_directory', `Path ${context.path ?? path} is not a directory. Choose a directory and retry.`, 400);
    }
    if (context.destination) {
      return new QubiclError('destination_invalid', `Destination ${context.destination} has a parent path that is not a directory. Choose another destination.`, 400);
    }
    return new QubiclError('path_invalid', `Path ${context.path ?? path} contains a component that is not a directory. Check the path and retry.`, 400);
  }
  if (code === 'EISDIR') {
    if (context.destination) {
      return new QubiclError('destination_invalid', `Destination ${context.destination} is a directory where a file is required. Choose another destination.`, 400);
    }
    return new QubiclError('not_a_file', `Path ${context.path ?? path} is not a regular file.`, 400);
  }
  if (code === 'ENOTEMPTY') {
    return new QubiclError('directory_not_empty', `Directory ${context.path ?? context.destination ?? path} is not empty. Retry with recursive deletion or choose another destination.`, 409);
  }
  if (code === 'EINVAL' || code === 'ENAMETOOLONG' || code === 'ELOOP') {
    if (context.destination) {
      return new QubiclError('destination_invalid', `Destination ${context.destination} is invalid for this operation. Choose another destination.`, 400);
    }
    return new QubiclError('path_invalid', `Path ${context.path ?? path} is invalid for this operation. Check the path and retry.`, 400);
  }
  if (code === 'EXDEV' && context.destination) {
    return new QubiclError('cross_device_move_unsupported', `Destination ${context.destination} is on a different filesystem. Copy the path and then delete the source instead.`, 400);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new QubiclError('permission_denied', `Permission was denied for ${path}. Choose an accessible path and retry.`, 403);
  }
  if (code === 'EROFS') {
    return new QubiclError('read_only_filesystem', `Path ${path} is on a read-only filesystem. Choose a writable path and retry.`, 403);
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new QubiclError('insufficient_storage', `There is not enough storage available to complete the operation at ${path}. Free space or choose another path.`, 507);
  }
  return error;
}

function inputPath(context: FileErrorContext, reportedPath: string | undefined): string {
  const inputs = [context.path, context.source, context.destination];
  return inputs.find((path) => path === reportedPath)
    ?? context.path
    ?? context.source
    ?? context.destination
    ?? 'the requested path';
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function errnoPath(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'path' in error && typeof error.path === 'string'
    ? error.path
    : undefined;
}
