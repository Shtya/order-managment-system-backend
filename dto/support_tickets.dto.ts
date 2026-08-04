import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, IsArray } from 'class-validator';
import { Transform } from 'class-transformer';
import { SupportTicketPriority, SupportTicketStatus } from 'entities/support_tickets.entity';

export class CreateSupportTicketDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(250)
	title: string;

	@IsString()
	@IsNotEmpty()
	message: string;
}

export class ReplySupportTicketDto {
	@IsOptional()
	@IsString()
	@MaxLength(10000)
	message?: string;

	@IsOptional()
	@Transform(({ value }) => value === true || value === 'true')
	@IsBoolean()
	isInternalNote?: boolean;
}

export class UpdateMessageDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(10000)
	message: string;
}

export class CloseTicketDto {
	@IsOptional()
	@IsString()
	@MaxLength(2000)
	reason?: string;
}

export class CancelTicketDto {
	@IsOptional()
	@IsString()
	@MaxLength(2000)
	reason?: string;
}

export class ReopenTicketDto {
	@IsOptional()
	@IsString()
	@MaxLength(10000)
	message?: string;
}

export class ResolveTicketDto {
	@IsOptional()
	@IsString()
	@MaxLength(10000)
	message?: string;
}

export class HoldTicketDto {
	@IsOptional()
	@IsString()
	@MaxLength(2000)
	reason?: string;
}

export class WaitingOnCustomerDto {
	@IsOptional()
	@IsString()
	@MaxLength(10000)
	message?: string;
}

export class UpdateTicketStatusDto {
	@IsEnum(SupportTicketStatus)
	status: SupportTicketStatus;

	@IsOptional()
	@IsString()
	@MaxLength(2000)
	reason?: string;
}

export class AssignSupportTicketDto {
	@IsUUID()
	assignedSupportUserId: string;
}

export class UpdateTicketPriorityDto {
	@IsEnum(SupportTicketPriority)
	priority: SupportTicketPriority;
}

export class BulkAssignTicketsDto {
	@IsArray()
	@IsUUID('4', { each: true })
	ticketIds: string[];

	@IsUUID()
	assignedSupportUserId: string;
}

export class BulkUpdateStatusDto {
	@IsArray()
	@IsUUID('4', { each: true })
	ticketIds: string[];

	@IsEnum(SupportTicketStatus)
	status: SupportTicketStatus;

	@IsOptional()
	@IsString()
	@MaxLength(2000)
	reason?: string;
}

export class BulkUpdatePriorityDto {
	@IsArray()
	@IsUUID('4', { each: true })
	ticketIds: string[];

	@IsEnum(SupportTicketPriority)
	priority: SupportTicketPriority;
}
