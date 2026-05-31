const Joi = require('joi');

const loginSchema = Joi.object({
  identifier: Joi.string().trim().min(3).max(254).required().messages({
    'string.empty': 'Username or email is required',
    'string.min': 'Username or email must be at least 3 characters',
  }),
  password: Joi.string().min(8).max(128).required().messages({
    'string.empty': 'Password is required',
    'string.min': 'Password must be at least 8 characters',
  }),
  adminLogin: Joi.boolean().optional(),
});

const registerSchema = Joi.object({
  username: Joi.string().trim().alphanum().min(3).max(30).required().messages({
    'string.alphanum': 'Username can only contain letters and numbers',
    'string.empty': 'Username is required',
    'string.min': 'Username must be at least 3 characters',
  }),
  email: Joi.string().trim().email().required().messages({
    'string.email': 'Email must be a valid email address',
    'string.empty': 'Email is required',
  }),
  password: Joi.string()
    .min(8)
    .max(128)
    .pattern(new RegExp('(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])(?=.*[!@#$%^&*])'))
    .required()
    .messages({
      'string.empty': 'Password is required',
      'string.min': 'Password must be at least 8 characters',
      'string.pattern.base': 'Password must contain uppercase, lowercase, number, and special character',
    }),
  confirmPassword: Joi.any().valid(Joi.ref('password')).required().messages({
    'any.only': 'Passwords must match',
    'any.required': 'Confirm password is required',
  }),
  adminSignup: Joi.boolean().optional(),
  adminCode: Joi.string().allow('', null).optional(),
});

const betSchema = Joi.object({
  type: Joi.string().valid('Single', '10X', 'All').required().messages({
    'any.only': 'Type must be Single, 10X, or All',
    'string.empty': 'Bet type is required',
  }),
  stake: Joi.number().positive().required().messages({
    'number.base': 'Stake must be a number',
    'number.positive': 'Stake must be positive',
    'any.required': 'Stake is required',
  }),
  odds: Joi.number().positive().required().messages({
    'number.base': 'Odds must be a number',
    'number.positive': 'Odds must be positive',
    'any.required': 'Odds are required',
  }),
  status: Joi.string().valid('Pending', 'Paid Out', 'Lost', 'Incremented', 'Decremented').required().messages({
    'any.only': 'Status is invalid',
    'string.empty': 'Status is required',
  }),
  match: Joi.string().trim().min(3).max(128).required().messages({
    'string.empty': 'Match label is required',
    'string.min': 'Match label must be at least 3 characters',
  }),
  predictedTeam: Joi.string().trim().min(2).max(64).optional(),
  date: Joi.string().optional(),
});

const forgotPasswordSchema = Joi.object({
  email: Joi.string().trim().email().required().messages({
    'string.email': 'Email must be a valid email address',
    'string.empty': 'Email is required',
  }),
});

const resetPasswordSchema = Joi.object({
  email: Joi.string().trim().email().required().messages({
    'string.email': 'Email must be a valid email address',
    'string.empty': 'Email is required',
  }),
  code: Joi.string().trim().pattern(/^[0-9]{6}$/).required().messages({
    'string.pattern.base': 'Code must be a 6-digit number',
    'string.empty': 'Code is required',
  }),
  password: Joi.string()
    .min(8)
    .max(128)
    .pattern(new RegExp('(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])(?=.*[!@#$%^&*])'))
    .required()
    .messages({
      'string.empty': 'Password is required',
      'string.min': 'Password must be at least 8 characters',
      'string.pattern.base': 'Password must contain uppercase, lowercase, number, and special character',
    }),
  confirmPassword: Joi.any().valid(Joi.ref('password')).required().messages({
    'any.only': 'Passwords must match',
    'any.required': 'Confirm password is required',
  }),
});

const adminCreditBalanceSchema = Joi.object({
  amount: Joi.number().positive().precision(2).required().messages({
    'number.base': 'Amount must be a number',
    'number.positive': 'Amount must be greater than zero',
    'any.required': 'Amount is required',
  }),
  reason: Joi.string().trim().min(3).max(160).required().messages({
    'string.empty': 'Reason is required',
    'string.min': 'Reason must be at least 3 characters',
  }),
});

const adminResetUserPasswordSchema = Joi.object({
  newPassword: Joi.string()
    .min(8)
    .max(128)
    .pattern(new RegExp('(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])(?=.*[!@#$%^&*])'))
    .required()
    .messages({
      'string.empty': 'New password is required',
      'string.min': 'New password must be at least 8 characters',
      'string.pattern.base': 'New password must contain uppercase, lowercase, number, and special character',
    }),
});

const adminCreateUserSchema = Joi.object({
  username: Joi.string().trim().alphanum().min(3).max(30).required().messages({
    'string.alphanum': 'Username can only contain letters and numbers',
    'string.empty': 'Username is required',
    'string.min': 'Username must be at least 3 characters',
  }),
  email: Joi.string().trim().email().required().messages({
    'string.email': 'Email must be a valid email address',
    'string.empty': 'Email is required',
  }),
  password: Joi.string()
    .min(8)
    .max(128)
    .pattern(new RegExp('(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])(?=.*[!@#$%^&*])'))
    .required()
    .messages({
      'string.empty': 'Password is required',
      'string.min': 'Password must be at least 8 characters',
      'string.pattern.base': 'Password must contain uppercase, lowercase, number, and special character',
    }),
});

const walletRequestSchema = Joi.object({
  type: Joi.string().valid('deposit', 'withdrawal').required().messages({
    'any.only': 'Type must be deposit or withdrawal',
    'any.required': 'Type is required',
  }),
  amount: Joi.number().positive().precision(2).required().messages({
    'number.base': 'Amount must be a number',
    'number.positive': 'Amount must be greater than zero',
    'any.required': 'Amount is required',
  }),
  note: Joi.string().trim().max(160).allow('').optional(),
});

const walletRequestDecisionSchema = Joi.object({
  status: Joi.string().valid('approved', 'rejected').required(),
  note: Joi.string().trim().max(160).allow('').optional(),
});

const supportTicketSchema = Joi.object({
  issueType: Joi.string().trim().min(2).max(60).required().messages({
    'string.empty': 'Issue type is required',
  }),
  message: Joi.string().trim().min(5).max(1200).required().messages({
    'string.empty': 'Message is required',
    'string.min': 'Message should have at least 5 characters',
  }),
});

module.exports = {
  loginSchema,
  registerSchema,
  betSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  adminCreditBalanceSchema,
  adminResetUserPasswordSchema,
  adminCreateUserSchema,
  walletRequestSchema,
  walletRequestDecisionSchema,
  supportTicketSchema,
};
